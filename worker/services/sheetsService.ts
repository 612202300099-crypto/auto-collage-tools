/**
 * sheetsService.ts — Google Sheets operations for the Worker.
 *
 * Multi-shop support: each shop has its own spreadsheet.
 * EDITOR column is auto-detected from the header row.
 *
 * Sheet: FOTO POLAROID (all shops share the same fixed columns)
 *   Col B = NO. RESI
 *   Col G = VARIASI (e.g., "25 Pcs", "50 Pcs")
 *   Col H = QTY
 *   Col J = STATUS TRANSAKSI
 *   Col M or N = EDITOR (auto-detected, varies per shop)
 *   Col after EDITOR = text field for bot info
 */
import { getSheetsClient } from './googleAuth.ts';
import { extractVariantFromText } from '../utils/folderParser.ts';
import { logger } from '../utils/logger.ts';
import type { SheetOrderData, ValidationResult, ShopColumnMapping } from '../types.ts';

// ─── Cache per Spreadsheet ──────────────────────────────────────────────────

interface SheetCache {
  data: string[][] | null;
  timestamp: number;
}

const cacheMap = new Map<string, SheetCache>();
const CACHE_TTL_MS = 120_000; // 2 minutes

/** Column mapping cache per spreadsheet (auto-detected from header) */
const columnMappingCache = new Map<string, ShopColumnMapping>();

// ─── Column Utilities ───────────────────────────────────────────────────────

/** Convert column letter to 0-based index. "A"→0, "B"→1, "N"→13, etc. */
function colLetterToIndex(letter: string): number {
  return letter.toUpperCase().charCodeAt(0) - 65;
}

/** Convert 0-based index to column letter. 0→"A", 1→"B", 13→"N", etc. */
function indexToColLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

/** Get the next column letter. "M"→"N", "N"→"O", etc. */
function nextColLetter(letter: string): string {
  return indexToColLetter(colLetterToIndex(letter) + 1);
}

// ─── Auto-detect EDITOR Column ──────────────────────────────────────────────

/**
 * Auto-detect the EDITOR column by scanning the header row.
 * Looks for a cell containing "EDITOR" (case-insensitive).
 * Returns the column mapping { editor, editorText }.
 */
export async function detectEditorColumn(
  spreadsheetId: string,
  sheetName: string,
): Promise<ShopColumnMapping> {
  // Check cache first
  const cacheKey = `${spreadsheetId}:${sheetName}`;
  const cached = columnMappingCache.get(cacheKey);
  if (cached) return cached;

  const sheets = getSheetsClient();

  // Read the first row (headers) — columns A through T to be safe
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!A1:T1`,
  });

  const headerRow = res.data.values?.[0] || [];

  // Find EDITOR column
  let editorIndex = -1;
  for (let i = 0; i < headerRow.length; i++) {
    const cell = (headerRow[i] || '').toString().toUpperCase();
    if (cell.includes('EDITOR')) {
      editorIndex = i;
      break;
    }
  }

  if (editorIndex === -1) {
    // Fallback: try column M (most common)
    logger.warn('SHEETS', `Could not find EDITOR column in header for ${sheetName}. Defaulting to column M.`);
    editorIndex = colLetterToIndex('M');
  }

  const editorLetter = indexToColLetter(editorIndex);
  const editorTextLetter = nextColLetter(editorLetter);

  const mapping: ShopColumnMapping = {
    editor: editorLetter,
    editorText: editorTextLetter,
  };

  columnMappingCache.set(cacheKey, mapping);
  logger.info('SHEETS', `Auto-detected EDITOR column: ${editorLetter}, text column: ${editorTextLetter} for ${sheetName}`);

  return mapping;
}

// ─── Fetch Data ─────────────────────────────────────────────────────────────

/**
 * Fetch all data from the FOTO POLAROID sheet.
 * Reads columns A through T (covers all possible column positions).
 */
async function fetchSheetData(
  spreadsheetId: string,
  sheetName: string,
  forceRefresh = false,
): Promise<string[][]> {
  const cacheKey = `${spreadsheetId}:${sheetName}`;
  const now = Date.now();

  const cached = cacheMap.get(cacheKey);
  if (!forceRefresh && cached?.data && (now - cached.timestamp) < CACHE_TTL_MS) {
    return cached.data;
  }

  const sheets = getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!A:T`,
  });

  const rows = res.data.values || [];
  cacheMap.set(cacheKey, { data: rows, timestamp: now });

  logger.debug('SHEETS', `Fetched ${rows.length} rows from ${sheetName} (${spreadsheetId.substring(0, 8)}...)`);
  return rows;
}

/**
 * Invalidate cache for a specific spreadsheet.
 */
export function invalidateCache(spreadsheetId?: string): void {
  if (spreadsheetId) {
    for (const key of cacheMap.keys()) {
      if (key.startsWith(spreadsheetId)) {
        cacheMap.delete(key);
      }
    }
  } else {
    cacheMap.clear();
  }
}

// ─── FOTO POLAROID Operations ───────────────────────────────────────────────

/**
 * Fixed column indices (0-based) that are the same across all shops.
 * These correspond to columns A-J in the spreadsheet.
 *
 * When we read range A:T, the columns map as:
 *   Index 1 = Column B (NO. RESI)
 *   Index 6 = Column G (VARIASI)
 *   Index 7 = Column H (QTY)
 *   Index 9 = Column J (STATUS TRANSAKSI)
 */
const COL_RESI = 1;        // Column B
const COL_VARIASI = 6;     // Column G
const COL_QTY = 7;         // Column H
const COL_STATUS = 9;      // Column J

/**
 * Find an order by resi number in the FOTO POLAROID sheet.
 */
export async function findOrderByResi(
  spreadsheetId: string,
  sheetName: string,
  resi: string,
  columns: ShopColumnMapping,
): Promise<SheetOrderData | null> {
  const rows = await fetchSheetData(spreadsheetId, sheetName);
  const editorIndex = colLetterToIndex(columns.editor);

  // Skip header row (row 0)
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const cellResi = (row[COL_RESI] || '').toString().trim();

    if (cellResi === resi) {
      const variasi = (row[COL_VARIASI] || '').toString().trim();
      const qtyRaw = (row[COL_QTY] || '').toString().trim();
      const status = (row[COL_STATUS] || '').toString().trim();
      const editorValue = (row[editorIndex] || '').toString().trim();

      const variant = extractVariantFromText(variasi) || 0;
      const qty = parseInt(qtyRaw, 10) || 1;
      const expectedPhotos = variant * qty;

      // Row number in sheet: i (0-indexed) + 1 (for 1-indexing)
      const rowNumber = i + 1;

      return {
        rowNumber,
        resi: cellResi,
        variant,
        qty,
        expectedPhotos,
        status,
        editorValue,
      };
    }
  }

  return null;
}

/**
 * Validate an order against the spreadsheet by Resi alone.
 * Relies on the spreadsheet as the source of truth for variant/qty.
 * Returns { valid, order, reason } for clear skip logging.
 */
export async function validateOrderByResi(
  spreadsheetId: string,
  sheetName: string,
  resi: string,
  columns: ShopColumnMapping,
): Promise<ValidationResult> {
  const order = await findOrderByResi(spreadsheetId, sheetName, resi, columns);

  if (!order) {
    return { valid: false, reason: `Resi ${resi} not found in spreadsheet` };
  }

  // Check: EDITOR column already has a value → already processed (by human or bot)
  if (order.editorValue) {
    return {
      valid: false,
      order,
      reason: `Already processed — EDITOR column: "${order.editorValue}"`,
    };
  }

  // Check: Status is DIBATALKAN (cancelled)
  if (order.status.toUpperCase() === 'DIBATALKAN') {
    return { valid: false, order, reason: `Order is DIBATALKAN (cancelled)` };
  }

  // Check: Has valid variant in spreadsheet
  if (order.variant <= 0) {
    return {
      valid: false,
      order,
      reason: `No valid variant (VARIASI) found in spreadsheet for this Resi`,
    };
  }

  return { valid: true, order };
}

/**
 * Mark an order as processed by BOT.
 * Writes "BOT" to the EDITOR column and editorText to the next column.
 */
export async function markAsProcessed(
  spreadsheetId: string,
  sheetName: string,
  rowNumber: number,
  columns: ShopColumnMapping,
  editorText: string,
): Promise<void> {
  const sheets = getSheetsClient();

  // Write "BOT" to EDITOR column
  const editorRange = `'${sheetName}'!${columns.editor}${rowNumber}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: editorRange,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [['BOT']],
    },
  });

  // Write editorText to the next column (if provided)
  if (editorText) {
    const textRange = `'${sheetName}'!${columns.editorText}${rowNumber}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: textRange,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[editorText]],
      },
    });
  }

  // Invalidate cache so next read sees the update
  invalidateCache(spreadsheetId);

  logger.success('SHEETS', `Marked row ${rowNumber} — EDITOR: "BOT", Text: "${editorText || '(none)'}"`);
}
