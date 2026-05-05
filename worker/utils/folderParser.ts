/**
 * folderParser.ts — Parse Google Drive folder names into structured order data.
 *
 * Handles multiple naming conventions:
 *   "JX9171527480_25 Pcs"  → { resi: "JX9171527480", variant: 25 }
 *   "JX9171527480_25"      → { resi: "JX9171527480", variant: 25 }
 *   "JX9171527480_100 Pcs" → { resi: "JX9171527480", variant: 100 }
 *
 * Also handles date folder classification:
 *   "25-04-2026" → DD_MM_YYYY
 *   "2026-04-25" → YYYY_MM_DD
 */
import type { ParsedOrder, DateFolderType, ClassifiedDateFolder, DriveFolder } from '../types.ts';

/**
 * Regex explanation:
 *   ^(.+?)           → Capture group 1: resi (non-greedy, everything before last underscore+number)
 *   _                → Literal underscore separator
 *   (\d+)            → Capture group 2: variant number
 *   (?:\s*Pcs)?      → Optional " Pcs" suffix (case-insensitive)
 *   $                → End of string
 */
const FOLDER_NAME_REGEX = /^(.+?)_(\d+)(?:\s*Pcs)?$/i;

/** Matches DD-MM-YYYY (e.g., "25-04-2026") */
const DATE_DD_MM_YYYY_REGEX = /^(\d{2})-(\d{2})-(\d{4})$/;

/** Matches YYYY-MM-DD (e.g., "2026-04-25") */
const DATE_YYYY_MM_DD_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseFolderName(folderName: string): ParsedOrder | null {
  const match = folderName.trim().match(FOLDER_NAME_REGEX);
  if (!match) return null;

  const resi = match[1].trim();
  const variant = parseInt(match[2], 10);

  if (!resi || isNaN(variant) || variant <= 0) return null;

  return {
    resi,
    variant,
    rawFolderName: folderName,
  };
}

/**
 * Build the expected output filename.
 * "JX9171527480" + 25 → "Cetak_JX9171527480_25.pdf"
 */
export function buildOutputFileName(resi: string, variant: number): string {
  return `Cetak_${resi}_${variant}.pdf`;
}

/**
 * Extract variant number from spreadsheet VARIASI column.
 * Examples:
 *   "25 Pcs"  → 25
 *   "50 Pcs"  → 50
 *   "100 Pcs" → 100
 *   "25"      → 25
 */
export function extractVariantFromText(text: string): number | null {
  const match = text.trim().match(/(\d+)/);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return isNaN(num) || num <= 0 ? null : num;
}

// ─── Date Folder Classification ─────────────────────────────────────────────

/**
 * Detect the type of date folder from its name.
 */
export function classifyDateFolder(name: string): DateFolderType {
  if (DATE_DD_MM_YYYY_REGEX.test(name)) return 'DD_MM_YYYY';
  if (DATE_YYYY_MM_DD_REGEX.test(name)) return 'YYYY_MM_DD';
  return 'UNKNOWN';
}

/**
 * Classify an array of DriveFolder into typed ClassifiedDateFolder.
 */
export function classifyDateFolders(folders: DriveFolder[]): ClassifiedDateFolder[] {
  return folders.map(f => ({
    ...f,
    type: classifyDateFolder(f.name),
  }));
}

/**
 * Convert YYYY-MM-DD → DD-MM-YYYY.
 * "2026-04-25" → "25-04-2026"
 */
export function convertYyyyMmDdToDdMmYyyy(yyyyMmDd: string): string {
  const match = yyyyMmDd.match(DATE_YYYY_MM_DD_REGEX);
  if (!match) throw new Error(`Invalid YYYY-MM-DD format: ${yyyyMmDd}`);
  return `${match[3]}-${match[2]}-${match[1]}`;
}

/**
 * Convert DD-MM-YYYY → YYYY-MM-DD.
 * "25-04-2026" → "2026-04-25"
 */
export function convertDdMmYyyyToYyyyMmDd(ddMmYyyy: string): string {
  const match = ddMmYyyy.match(DATE_DD_MM_YYYY_REGEX);
  if (!match) throw new Error(`Invalid DD-MM-YYYY format: ${ddMmYyyy}`);
  return `${match[3]}-${match[2]}-${match[1]}`;
}

/**
 * Build the target order folder name for migration.
 * "JX9195703370" + 100 → "JX9195703370_100 Pcs"
 */
export function buildOrderFolderName(resi: string, variant: number): string {
  return `${resi}_${variant} Pcs`;
}
