/**
 * folderParser.ts — Parse Google Drive folder names into structured order data.
 *
 * Handles naming conventions for order folders:
 *   "JX9171527480_25 Pcs"  → { resi: "JX9171527480", variant: 25 }
 *   "JX9171527480_25"      → { resi: "JX9171527480", variant: 25 }
 *   "JX9171527480_100 Pcs" → { resi: "JX9171527480", variant: 100 }
 */
import type { ParsedOrder } from '../types.ts';

/**
 * Regex explanation:
 *   ^(.+?)           → Capture group 1: resi (non-greedy, everything before last underscore+number)
 *   _                → Literal underscore separator
 *   (\d+)            → Capture group 2: variant number
 *   (?:\s*Pcs)?      → Optional " Pcs" suffix (case-insensitive)
 *   $                → End of string
 */
const FOLDER_NAME_REGEX = /^(.+?)_(\d+)(?:\s*Pcs)?$/i;

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

/**
 * Build the target order folder name.
 * "JX9195703370" + 100 → "JX9195703370_100 Pcs"
 */
export function buildOrderFolderName(resi: string, variant: number): string {
  return `${resi}_${variant} Pcs`;
}
