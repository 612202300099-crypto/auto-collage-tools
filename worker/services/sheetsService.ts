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
import { parseDDMMYYYY, isDateInRange } from '../utils/dateUtils.ts';
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
 * Auto-detect the dynamic columns by scanning the header row.
 * Returns the column mapping { statusCol, botCol, batchCol }.
 */
export async function detectShopColumns(
  spreadsheetId: string,
  sheetName: string,
): Promise<ShopColumnMapping> {
  // Check cache first
  const cacheKey = `${spreadsheetId}:${sheetName}`;
  const cached = columnMappingCache.get(cacheKey);
  if (cached) return cached;

  const sheets = getSheetsClient();

  // Read the first row (headers) — columns A through Z to be safe
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!A1:Z1`,
  });

  const headerRow = res.data.values?.[0] || [];

  let statusColIndex = -1;
  let botColIndex = -1;
  let batchColIndex = -1;

  for (let i = 0; i < headerRow.length; i++) {
    const cell = (headerRow[i] || '').toString().toUpperCase();
    if (cell === 'STATUS' || (cell.includes('STATUS') && !cell.includes('TRANSAKSI'))) {
      statusColIndex = i;
    } else if (cell.includes('DIKERJAKAN BOT')) {
      botColIndex = i;
    } else if (cell.includes('UPLOAD BATCH') || cell.includes('BATCH UPLOAD')) {
      batchColIndex = i;
    }
  }

  // Find the last non-empty column index to append safely
  let lastFilledIndex = -1;
  for (let i = 0; i < headerRow.length; i++) {
    if ((headerRow[i] || '').toString().trim() !== '') {
      lastFilledIndex = i;
    }
  }

  // Fallbacks: dynamically append to the end of existing columns to prevent overwriting
  if (statusColIndex === -1) {
    statusColIndex = lastFilledIndex + 1;
    lastFilledIndex++;
    logger.warn('SHEETS', `Could not find STATUS column in header for ${sheetName}. Appending to column ${indexToColLetter(statusColIndex)}.`);
  }
  if (botColIndex === -1) {
    botColIndex = lastFilledIndex + 1;
    lastFilledIndex++;
    logger.warn('SHEETS', `Could not find DIKERJAKAN BOT column in header for ${sheetName}. Appending to column ${indexToColLetter(botColIndex)}.`);
  }
  if (batchColIndex === -1) {
    batchColIndex = lastFilledIndex + 1;
    lastFilledIndex++;
    logger.warn('SHEETS', `Could not find UPLOAD BATCH column in header for ${sheetName}. Appending to column ${indexToColLetter(batchColIndex)}.`);
  }

  const mapping: ShopColumnMapping = {
    statusCol: indexToColLetter(statusColIndex),
    botCol: indexToColLetter(botColIndex),
    batchCol: indexToColLetter(batchColIndex),
  };

  columnMappingCache.set(cacheKey, mapping);
  logger.info('SHEETS', `Auto-detected columns for ${sheetName}: Status=${mapping.statusCol}, Bot=${mapping.botCol}, Batch=${mapping.batchCol}`);

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
    range: `'${sheetName}'!A:Z`,
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
 * Fixed column indices (0-based) yang sama di semua toko.
 * Kolom-kolom ini TIDAK pernah bergeser — sudah disepakati sebagai standar sheet.
 *
 *   Index 0 = Kolom A (TANGGAL ORDER — format DD-MM-YYYY)
 *   Index 1 = Kolom B (NO. RESI)
 *   Index 6 = Kolom G (VARIASI, misal: "25 Pcs")
 *   Index 7 = Kolom H (QTY — jumlah copy cetak)
 *   Index 9 = Kolom J (STATUS TRANSAKSI)
 */
const COL_DATE    = 0;  // Kolom A — Tanggal Order (DD-MM-YYYY)
const COL_RESI    = 1;  // Kolom B — No. Resi
const COL_VARIASI = 6;  // Kolom G — Variasi (jumlah foto)
const COL_QTY     = 7;  // Kolom H — Qty (jumlah copy)
const COL_STATUS  = 9;  // Kolom J — Status Transaksi

/**
 * Rentang tanggal untuk memfilter order yang akan diproses.
 * Kedua batas bersifat opsional dan inklusif.
 */
export interface DateRange {
  /** Batas awal inklusif (awal hari). Undefined = tidak ada batas bawah. */
  from?: Date;
  /** Batas akhir inklusif (akhir hari). Undefined = tidak ada batas atas. */
  to?: Date;
}

/**
 * Cari semua baris yang cocok dengan nomor resi di sheet.
 * Mengembalikan array (bukan satu baris) karena satu resi bisa punya
 * beberapa baris di spreadsheet (misal: order dengan varian berbeda).
 */
export async function findOrderByResi(
  spreadsheetId: string,
  sheetName: string,
  resi: string,
  columns: ShopColumnMapping,
): Promise<SheetOrderData[]> {
  const rows = await fetchSheetData(spreadsheetId, sheetName);
  const botIndex       = colLetterToIndex(columns.botCol);
  const statusColIndex = colLetterToIndex(columns.statusCol);

  const results: SheetOrderData[] = [];

  // Mulai dari baris ke-2 (index 1) — baris ke-1 (index 0) adalah header
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const cellResi = (row[COL_RESI] || '').toString().trim();

    if (cellResi !== resi) continue;

    const orderDate    = (row[COL_DATE]    || '').toString().trim();
    const variasi      = (row[COL_VARIASI] || '').toString().trim();
    const qtyRaw       = (row[COL_QTY]    || '').toString().trim();
    const status       = (row[COL_STATUS]  || '').toString().trim();
    const botStatusValue = (row[statusColIndex] || '').toString().trim();
    const botValue       = (row[botIndex]       || '').toString().trim();

    const variant       = extractVariantFromText(variasi) || 0;
    const qty           = parseInt(qtyRaw, 10) || 1;
    const expectedPhotos = variant * qty;

    // Nomor baris di sheet: i (0-indexed) + 1 (karena header di baris 1, data mulai baris 2)
    const rowNumber = i + 1;

    results.push({
      rowNumber,
      resi: cellResi,
      variant,
      qty,
      expectedPhotos,
      status,
      botStatusValue,
      botValue,
      orderDate,
    });
  }

  return results;
}

/**
 * Validasi order berdasarkan nomor resi, dengan dukungan filter varian dan tanggal.
 *
 * Logika validasi (berurutan, berhenti di kandidat pertama yang valid):
 *   1. Resi tidak ditemukan di sheet → invalid
 *   2. Filter varian: prioritaskan baris yang cocok dengan varian folder
 *   3. Filter tanggal: skip baris yang tanggal ordernya di luar rentang
 *   4. Kolom DIKERJAKAN BOT sudah "DONE" → skip (sudah dikerjakan)
 *   5. Kolom Status sudah SELESAI/PROSES → skip
 *   6. Status transaksi TERKIRIM/DIBATALKAN/TRANSIT/SELESAI → skip
 *   7. Variant tidak valid (0) → skip
 *   8. Semua lolos → valid!
 *
 * @param spreadsheetId - ID Google Spreadsheet toko
 * @param sheetName     - Nama sheet (misal: "FOTO POLAROID")
 * @param resi          - Nomor resi yang dicari
 * @param columns       - Mapping kolom dinamis (Status, Bot, Batch)
 * @param folderVariant - Variant dari nama folder Drive (opsional, untuk filtering)
 * @param dateRange     - Filter rentang tanggal (opsional, undefined = semua tanggal)
 */
export async function validateOrderByResi(
  spreadsheetId: string,
  sheetName: string,
  resi: string,
  columns: ShopColumnMapping,
  folderVariant?: number,
  dateRange?: DateRange,
): Promise<ValidationResult> {
  const matches = await findOrderByResi(spreadsheetId, sheetName, resi, columns);

  if (matches.length === 0) {
    return { valid: false, reason: `Resi ${resi} tidak ditemukan di spreadsheet` };
  }

  // ── Filter berdasarkan varian folder (jika ada) ───────────────────────────
  // Tujuan: jika folder bernama "JX12345_25 Pcs", prioritaskan baris varian 25
  let candidates = matches;
  if (folderVariant) {
    const exactMatch = matches.filter(m => m.variant === folderVariant);
    // Gunakan exact match jika ada, fallback ke semua baris jika tidak ada
    if (exactMatch.length > 0) {
      candidates = exactMatch;
    }
  }

  // ── Cari kandidat pertama yang lolos semua validasi ──────────────────────
  let lastReason = '';

  for (const order of candidates) {
    // ── Cek 1: Filter Tanggal (Kolom A) ────────────────────────────────────
    if (dateRange && (dateRange.from || dateRange.to)) {
      if (!order.orderDate) {
        lastReason = `Kolom A (tanggal) kosong — tidak bisa divalidasi rentang tanggal`;
        continue;
      }
      const orderDateParsed = parseDDMMYYYY(order.orderDate);
      if (!orderDateParsed) {
        lastReason = `Format tanggal "${order.orderDate}" di Kolom A tidak valid (harap DD-MM-YYYY)`;
        continue;
      }
      if (!isDateInRange(orderDateParsed, dateRange.from, dateRange.to)) {
        const fromStr = dateRange.from ? dateRange.from.toLocaleDateString('id-ID') : '∞';
        const toStr   = dateRange.to   ? dateRange.to.toLocaleDateString('id-ID')   : '∞';
        lastReason = `Tanggal order "${order.orderDate}" di luar rentang filter [${fromStr} – ${toStr}]`;
        continue;
      }
    }

    // ── Cek 2: Kolom DIKERJAKAN BOT sudah "DONE" ───────────────────────────
    if (order.botValue.toUpperCase() === 'DONE') {
      lastReason = `Sudah dikerjakan — kolom DIKERJAKAN BOT bernilai "DONE"`;
      continue;
    }

    // ── Cek 3: Kolom Status Bot sudah SELESAI atau PROSES ──────────────────
    const botStatusUpper = order.botStatusValue.toUpperCase();
    if (botStatusUpper.includes('SELESAI') || botStatusUpper.includes('PROSES')) {
      lastReason = `Order sudah berstatus "${botStatusUpper}" di kolom Status`;
      continue;
    }

    // ── Cek 4: Status Transaksi sudah final ────────────────────────────────
    const statusUpper = order.status.toUpperCase();
    if (
      statusUpper.includes('TERKIRIM')  ||
      statusUpper.includes('DIBATALKAN') ||
      statusUpper.includes('TRANSIT')   ||
      statusUpper.includes('SELESAI')
    ) {
      lastReason = `Status transaksi sudah final: "${statusUpper}"`;
      continue;
    }

    // ── Cek 5: Variant harus valid (> 0) ───────────────────────────────────
    if (order.variant <= 0) {
      lastReason = `Tidak ada variant foto yang valid di kolom VARIASI`;
      continue;
    }

    // ── Semua cek lolos → order valid! ────────────────────────────────────
    return { valid: true, order };
  }

  // Tidak ada kandidat yang valid — kembalikan alasan terakhir
  return { valid: false, order: candidates[0], reason: lastReason || 'Validasi gagal' };
}

/**
 * Update the status of an order in the spreadsheet in real-time.
 * Uses the auto-detected column mappings.
 */
export async function updateOrderStatus(
  spreadsheetId: string,
  sheetName: string,
  rowNumber: number,
  columns: ShopColumnMapping,
  updates: {
    statusText?: string;
    botDone?: boolean;
    batchText?: string;
  }
): Promise<void> {
  const sheets = getSheetsClient();
  const data: any[] = [];

  if (updates.statusText !== undefined) {
    data.push({
      range: `'${sheetName}'!${columns.statusCol}${rowNumber}`,
      values: [[updates.statusText]],
    });
  }

  if (updates.botDone !== undefined) {
    data.push({
      range: `'${sheetName}'!${columns.botCol}${rowNumber}`,
      values: [[updates.botDone ? 'DONE' : '']],
    });
  }

  if (updates.batchText !== undefined) {
    data.push({
      range: `'${sheetName}'!${columns.batchCol}${rowNumber}`,
      values: [[updates.batchText]],
    });
  }

  if (data.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data,
    },
  });

  // Invalidate cache for this spreadsheet so next read is fresh
  invalidateCache(spreadsheetId);

  logger.success('SHEETS', `Updated row ${rowNumber} — Status: ${updates.statusText || '-'}, Bot: ${updates.botDone ? 'DONE' : '-'}, Batch: ${updates.batchText || '-'}`);
}
