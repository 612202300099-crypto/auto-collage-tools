/**
 * sheetsService.ts — Google Sheets operations for the Worker.
 *
 * Responsibilities:
 * - Read "FOTO POLAROID" sheet data
 * - Find order by resi number (Column B)
 * - Validate order (variant, qty, status, done)
 * - Mark order as DONE in Column K (VARIAN)
 * - Read "EKSPORT" sheet to lookup Tracking ID (resi) from order ID
 *
 * Sheet: FOTO POLAROID
 *   Row 2 = Headers, Row 4 = Sub-headers, Data starts at Row 5+
 *   Col B = NO. RESI (sub: kolom AN)
 *   Col G = VARIASI (sub: kolom K), e.g., "25 Pcs", "50 Pcs"
 *   Col H = QTY (sub: kolom L)
 *   Col J = STATUS TRANSAKSI (sub: kolom E)
 *   Col K = VARIAN — write "done" here after processing
 *
 * Sheet: EKSPORT
 *   Row 1 = Headers, Row 2 = Descriptions, Row 3 = Sub-headers, Data starts at Row 4+
 *   Col C = Platform unique order ID
 *   Col AP = Tracking ID (resi)
 */
import { getSheetsClient } from './googleAuth.ts';
import { extractVariantFromText } from '../utils/folderParser.ts';
import { logger } from '../utils/logger.ts';
import type { SheetOrderData, ValidationResult, EksportOrderData } from '../types.ts';

// ─── Cache: FOTO POLAROID ───────────────────────────────────────────────────
let cachedFotoData: string[][] | null = null;
let fotoDataTimestamp: number = 0;
const CACHE_TTL_MS = 60_000; // 1 minute cache

// ─── Cache: EKSPORT ─────────────────────────────────────────────────────────
let cachedEksportData: string[][] | null = null;
let eksportDataTimestamp: number = 0;

// ─── Fetch Data ─────────────────────────────────────────────────────────────

/**
 * Fetch all data from the FOTO POLAROID sheet.
 * Reads columns B through K (we need B, G, H, J, K).
 */
async function fetchFotoData(
  spreadsheetId: string,
  sheetName: string,
  forceRefresh = false
): Promise<string[][]> {
  const now = Date.now();

  if (!forceRefresh && cachedFotoData && (now - fotoDataTimestamp) < CACHE_TTL_MS) {
    return cachedFotoData;
  }

  const sheets = getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!B:K`,
  });

  const rows = res.data.values || [];
  cachedFotoData = rows;
  fotoDataTimestamp = now;

  logger.debug('SHEETS', `Fetched ${rows.length} rows from ${sheetName}`);
  return rows;
}

/**
 * Fetch all data from the EKSPORT sheet.
 * Reads columns C and AP (order ID and tracking ID).
 * Since AP is column 42, we read A:AP to keep column indices consistent.
 */
async function fetchEksportData(
  spreadsheetId: string,
  eksportSheetName: string,
  forceRefresh = false
): Promise<string[][]> {
  const now = Date.now();

  if (!forceRefresh && cachedEksportData && (now - eksportDataTimestamp) < CACHE_TTL_MS) {
    return cachedEksportData;
  }

  const sheets = getSheetsClient();

  // Read columns A through AP (AP = column 42, 0-indexed = 41)
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${eksportSheetName}'!A:AP`,
  });

  const rows = res.data.values || [];
  cachedEksportData = rows;
  eksportDataTimestamp = now;

  logger.debug('SHEETS', `Fetched ${rows.length} rows from ${eksportSheetName}`);
  return rows;
}

/**
 * Invalidate all caches.
 */
export function invalidateCache(): void {
  cachedFotoData = null;
  fotoDataTimestamp = 0;
  cachedEksportData = null;
  eksportDataTimestamp = 0;
}

// ─── FOTO POLAROID Operations ───────────────────────────────────────────────

/**
 * Find an order by resi number in the FOTO POLAROID sheet.
 *
 * When we read range B:K, the columns map as:
 *   Index 0 = Column B (NO. RESI)
 *   Index 5 = Column G (VARIASI)    — B(0) C(1) D(2) E(3) F(4) G(5)
 *   Index 6 = Column H (QTY)        — H(6)
 *   Index 8 = Column J (STATUS)      — I(7) J(8)
 *   Index 9 = Column K (VARIAN)      — K(9)
 */
export async function findOrderByResi(
  spreadsheetId: string,
  sheetName: string,
  resi: string
): Promise<SheetOrderData | null> {
  const rows = await fetchFotoData(spreadsheetId, sheetName);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const cellB = (row[0] || '').toString().trim();

    if (cellB === resi) {
      const variasi = (row[5] || '').toString().trim();   // Col G
      const qtyRaw = (row[6] || '').toString().trim();    // Col H
      const status = (row[8] || '').toString().trim();     // Col J
      const varianFlag = (row[9] || '').toString().trim(); // Col K (VARIAN)

      const variant = extractVariantFromText(variasi);
      const qty = parseInt(qtyRaw, 10) || 1;

      // Row number in sheet: i (0-indexed) + 1 (for 1-indexing)
      const rowNumber = i + 1;

      return {
        rowNumber,
        resi: cellB,
        variant: variant || 0,
        qty,
        status,
        isDone: varianFlag.toUpperCase() === 'DONE',
      };
    }
  }

  return null;
}

/**
 * Validate an order against the spreadsheet.
 * Returns { valid, order, reason } for clear skip logging.
 */
export async function validateOrder(
  spreadsheetId: string,
  sheetName: string,
  resi: string,
  expectedVariant: number
): Promise<ValidationResult> {
  const order = await findOrderByResi(spreadsheetId, sheetName, resi);

  if (!order) {
    return { valid: false, reason: `Resi ${resi} not found in spreadsheet` };
  }

  // Check: Already marked as DONE in Column K (Layer 3)
  if (order.isDone) {
    return { valid: false, order, reason: `Already marked "done" in Column K (VARIAN)` };
  }

  // Check: Status is DIBATALKAN (Layer 4)
  if (order.status.toUpperCase() === 'DIBATALKAN') {
    return { valid: false, order, reason: `Order is DIBATALKAN (cancelled)` };
  }

  // Check: Variant mismatch
  // Variant bisa 0 jika kolom G kosong, skip validation in that case
  if (order.variant > 0 && order.variant !== expectedVariant) {
    return {
      valid: false,
      order,
      reason: `Variant mismatch: folder says ${expectedVariant}, spreadsheet says ${order.variant}`,
    };
  }

  return { valid: true, order };
}

/**
 * Mark an order as "done" in Column K (VARIAN) of FOTO POLAROID.
 */
export async function markAsDone(
  spreadsheetId: string,
  sheetName: string,
  rowNumber: number
): Promise<void> {
  const sheets = getSheetsClient();

  // Column K = the 11th column
  const range = `'${sheetName}'!K${rowNumber}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [['done']],
    },
  });

  // Invalidate cache so next read sees the update
  invalidateCache();

  logger.success('SHEETS', `Marked row ${rowNumber} as "done" in Column K (VARIAN)`);
}

// ─── EKSPORT Operations ─────────────────────────────────────────────────────

/**
 * Lookup a resi (Tracking ID) from the EKSPORT sheet by matching
 * a subfolder name against Column C (Platform unique order ID).
 *
 * Column mapping (range A:AP, 0-indexed):
 *   Index 2  = Column C  (Platform unique order ID)
 *   Index 10 = Column K  (Variation, e.g., "100 Pcs", "50 Pcs")
 *   Index 11 = Column L  (Quantity)
 *   Index 41 = Column AP (Tracking ID / Resi)
 *
 * The subfolder name may include variant suffix: "583734596181722839_50 pcs"
 * We strip the suffix and match on the 18-digit order ID only.
 */
export async function lookupResiFromEksport(
  spreadsheetId: string,
  eksportSheetName: string,
  subfolderName: string
): Promise<EksportOrderData | null> {
  const rows = await fetchEksportData(spreadsheetId, eksportSheetName);

  // Strip variant suffix if present (e.g., "583734596181722839_50 pcs" → "583734596181722839")
  const rawName = subfolderName.trim();
  const orderIdMatch = rawName.match(/^(\d{15,19})/); // Extract leading digits (15-19 digit order ID)
  const needle = orderIdMatch ? orderIdMatch[1] : rawName;

  // Skip header rows (rows 0-2 are header/description/sub-header)
  for (let i = 3; i < rows.length; i++) {
    const row = rows[i];
    const colC = (row[2] || '').toString().trim();   // Column C (index 2)
    const colAP = (row[41] || '').toString().trim();  // Column AP (index 41)

    if (!colAP) continue; // No resi assigned yet — skip

    // Exact match on Column C (Platform order ID)
    if (colC === needle) {
      const colK = (row[10] || '').toString().trim();  // Column K (Variation)
      const colL = (row[11] || '').toString().trim();   // Column L (Quantity)

      const variant = extractVariantFromText(colK) || 0;
      const qty = parseInt(colL, 10) || 1;
      const expectedPhotos = variant * qty;

      return {
        rowNumber: i + 1,
        orderIdPlatform: colC,
        variant,
        qty,
        expectedPhotos,
        resi: colAP,
      };
    }
  }

  return null;
}

