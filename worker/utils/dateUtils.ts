/**
 * dateUtils.ts — Utilitas parsing dan perbandingan tanggal untuk Worker.
 *
 * Modul ini menangani dua format tanggal yang digunakan dalam sistem:
 *   1. DD-MM-YYYY  → Format di spreadsheet (Kolom A)
 *   2. YYYY-MM-DD  → Format standar HTML date input (dari dashboard)
 *
 * Semua fungsi bersifat pure (tidak ada side effect) dan mengembalikan
 * null jika input tidak valid, sehingga caller bisa menangani gracefully.
 */

/**
 * Parse tanggal dari format DD-MM-YYYY, DD/MM/YYYY, atau DD.MM.YYYY.
 *
 * Contoh:
 *   "18-05-2026"  → Date(2026, 4, 18)
 *   "01/12/2025"  → Date(2025, 11, 1)
 *   "invalid"     → null
 *
 * @param str - String tanggal yang akan di-parse
 * @returns Date object jika valid, null jika tidak
 */
export function parseDDMMYYYY(str: string): Date | null {
  if (!str || typeof str !== 'string') return null;

  // Mendukung separator: -, /, .
  const match = str.trim().match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (!match) return null;

  const day   = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const year  = parseInt(match[3], 10);

  // Validasi range dasar sebelum membuat object Date
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (year < 2000 || year > 2100) return null;

  const d = new Date(year, month - 1, day);

  // Validasi lanjutan: Date akan auto-correct jika tanggal invalid
  // (misal: 31 Feb → 3 Mar), jadi kita cek ulang komponennya
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    return null;
  }

  return d;
}

/**
 * Parse tanggal dari format YYYY-MM-DD (standard HTML date input).
 *
 * Contoh:
 *   "2026-05-18"  → Date(2026, 4, 18)
 *   "2025-12-01"  → Date(2025, 11, 1)
 *   "invalid"     → null
 *
 * @param str - String tanggal dari HTML date input
 * @returns Date object jika valid, null jika tidak
 */
export function parseYYYYMMDD(str: string): Date | null {
  if (!str || typeof str !== 'string') return null;

  const match = str.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year  = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day   = parseInt(match[3], 10);

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (year < 2000 || year > 2100) return null;

  const d = new Date(year, month - 1, day);

  // Validasi konsistensi (sama seperti di atas)
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    return null;
  }

  return d;
}

/**
 * Cek apakah sebuah tanggal berada dalam rentang [from, to] secara inklusif.
 *
 * - Batas "from" adalah awal hari (00:00:00)
 * - Batas "to" adalah akhir hari (23:59:59.999)
 * - Jika from/to tidak diisi (undefined), batas tersebut dianggap terbuka
 *
 * Contoh:
 *   isDateInRange(18 Mei 2026, 17 Mei 2026, 19 Mei 2026) → true
 *   isDateInRange(16 Mei 2026, 17 Mei 2026, 19 Mei 2026) → false
 *
 * @param date - Tanggal yang akan dicek
 * @param from - Batas awal rentang (opsional, inklusif)
 * @param to   - Batas akhir rentang (opsional, inklusif)
 * @returns true jika tanggal berada dalam rentang
 */
export function isDateInRange(date: Date, from?: Date, to?: Date): boolean {
  if (from) {
    // Bandingkan dengan awal hari (midnight)
    const startOfFrom = new Date(
      from.getFullYear(),
      from.getMonth(),
      from.getDate(),
      0, 0, 0, 0,
    );
    if (date < startOfFrom) return false;
  }

  if (to) {
    // Bandingkan dengan akhir hari (23:59:59.999)
    const endOfTo = new Date(
      to.getFullYear(),
      to.getMonth(),
      to.getDate(),
      23, 59, 59, 999,
    );
    if (date > endOfTo) return false;
  }

  return true;
}

/**
 * Format Date ke string YYYY-MM-DD (untuk HTML date input value).
 *
 * Contoh: Date(2026, 4, 18) → "2026-05-18"
 *
 * @param date - Date object yang akan diformat
 * @returns String dalam format YYYY-MM-DD
 */
export function formatToYYYYMMDD(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Format Date ke string DD-MM-YYYY (format spreadsheet).
 *
 * Contoh: Date(2026, 4, 18) → "18-05-2026"
 *
 * @param date - Date object yang akan diformat
 * @returns String dalam format DD-MM-YYYY
 */
export function formatToDDMMYYYY(date: Date): string {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}-${m}-${y}`;
}
