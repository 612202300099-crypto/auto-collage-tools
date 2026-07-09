/**
 * dbService.ts — SQLite Persistent Storage untuk AutoCollage Worker.
 *
 * Modul ini menyediakan dua kapabilitas utama:
 *
 * 1. PERSISTENT ORDER TRACKING (Layer 3 Anti-Duplikasi)
 *    Mencatat setiap order yang berhasil diproses ke database lokal.
 *    Saat worker di-restart, order yang sudah ada di DB langsung di-skip
 *    tanpa perlu query ke Google Sheets/Drive → hemat kuota API & lebih cepat.
 *
 * 2. CONFIG PERSISTENCE
 *    Menyimpan konfigurasi runtime (date range filter) ke DB sehingga
 *    pengaturan tetap ada meskipun worker di-restart.
 *
 * Implementasi menggunakan better-sqlite3:
 *   - Synchronous API (tidak perlu async/await) → lebih sederhana
 *   - Single file database → mudah di-backup
 *   - WAL mode → performa baca tulis yang lebih baik
 *   - Zero configuration → tidak perlu server terpisah
 *
 * Schema Database:
 *   - processed_orders: Riwayat order yang berhasil diproses
 *   - worker_config:    Konfigurasi persistent (date range, dll)
 */

import Database, { type Database as BetterSqlite3Database } from 'better-sqlite3';
import { logger } from '../utils/logger.ts';
import type { ProcessedOrderRecord } from '../types.ts';

// ─── Instance Database ───────────────────────────────────────────────────────

/** Singleton instance database. Null sebelum initDb() dipanggil. */
let db: BetterSqlite3Database | null = null;

// ─── Schema SQL ──────────────────────────────────────────────────────────────

/**
 * DDL untuk membuat tabel jika belum ada.
 * Menggunakan IF NOT EXISTS agar aman dipanggil berkali-kali.
 */
const SCHEMA_SQL = `
  -- ── Tabel 1: Riwayat order yang sudah berhasil diproses ──────────────────
  CREATE TABLE IF NOT EXISTS processed_orders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_name    TEXT    NOT NULL,
    resi         TEXT    NOT NULL,
    variant      INTEGER NOT NULL DEFAULT 0,
    processed_at INTEGER NOT NULL,        -- Unix timestamp (ms) kapan diproses
    batch_text   TEXT    NOT NULL DEFAULT '',
    row_number   INTEGER NOT NULL DEFAULT 0,

    -- Constraint: satu kombinasi shop+resi+variant hanya boleh ada sekali
    UNIQUE(shop_name, resi, variant)
  );

  -- Index untuk mempercepat query lookup (isOrderProcessed dipanggil sangat sering)
  CREATE INDEX IF NOT EXISTS idx_processed_shop_resi
    ON processed_orders(shop_name, resi);

  -- ── Tabel 2: Konfigurasi persistent key-value ─────────────────────────────
  CREATE TABLE IF NOT EXISTS worker_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );

  -- Seed nilai default untuk date range (kosong = tidak ada filter)
  INSERT OR IGNORE INTO worker_config(key, value) VALUES ('date_from', '');
  INSERT OR IGNORE INTO worker_config(key, value) VALUES ('date_to', '');
`;

// ─── Inisialisasi ────────────────────────────────────────────────────────────

/**
 * Inisialisasi database SQLite.
 * Harus dipanggil SEKALI saat aplikasi boot, sebelum fungsi lain digunakan.
 *
 * @param dbPath - Path ke file .db (akan dibuat otomatis jika belum ada)
 */
export function initDb(dbPath: string): void {
  if (db) {
    logger.warn('DB', 'Database already initialized, skipping re-init');
    return;
  }

  // Buat koneksi (file dibuat otomatis jika belum ada)
  db = new Database(dbPath);

  // WAL mode: Write-Ahead Logging → performa lebih baik untuk concurrent reads
  db.pragma('journal_mode = WAL');

  // Foreign keys sebagai best practice (meskipun tidak dipakai di schema ini)
  db.pragma('foreign_keys = ON');

  // Jalankan schema (idempotent berkat IF NOT EXISTS)
  db.exec(SCHEMA_SQL);

  logger.success('DB', `SQLite database ready: ${dbPath}`);
}

/**
 * Helper internal: dapatkan instance DB yang sudah diinisialisasi.
 * Melempar error jika initDb() belum pernah dipanggil.
 */
function getDb(): BetterSqlite3Database {
  if (!db) {
    throw new Error(
      '[DB] Database not initialized. Pastikan initDb() dipanggil di awal aplikasi.',
    );
  }
  return db;
}

// ─── Order Tracking ──────────────────────────────────────────────────────────

/**
 * Cek apakah sebuah order sudah pernah berhasil diproses di sesi sebelumnya.
 *
 * Ini adalah operasi paling sering dipanggil (setiap scan cycle untuk setiap folder).
 * Menggunakan prepared statement yang di-cache oleh better-sqlite3 secara otomatis.
 *
 * @param shopName - Nama toko (CUSTOMBASE, GIFTYOURS, VENTURA)
 * @param resi     - Nomor resi order
 * @param variant  - Jumlah foto (25, 50, 100, dll.)
 * @returns true jika sudah diproses, false jika belum
 */
export function isOrderProcessed(
  shopName: string,
  resi: string,
  variant: number,
): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM processed_orders
       WHERE shop_name = ? AND resi = ? AND variant = ?
       LIMIT 1`,
    )
    .get(shopName, resi, variant);

  return row !== undefined;
}

/**
 * Catat order sebagai sudah berhasil diproses.
 * Menggunakan INSERT OR IGNORE sehingga aman dipanggil berkali-kali
 * untuk order yang sama (tidak akan throw error, hanya di-ignore).
 *
 * @param shopName  - Nama toko
 * @param resi      - Nomor resi
 * @param variant   - Jumlah foto
 * @param batchText - Label batch yang digunakan (misal: "BATCH 1")
 * @param rowNumber - Nomor baris di spreadsheet
 */
export function markOrderProcessed(
  shopName: string,
  resi: string,
  variant: number,
  batchText: string = '',
  rowNumber: number = 0,
): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO processed_orders
         (shop_name, resi, variant, processed_at, batch_text, row_number)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(shopName, resi, variant, Date.now(), batchText, rowNumber);

  logger.info('DB', `Recorded: [${shopName}] ${resi} (${variant} pcs) — Batch: "${batchText}", Row: ${rowNumber}`);
}

/**
 * Ambil daftar order yang sudah diproses untuk ditampilkan di dashboard.
 * Diurutkan dari yang paling baru.
 *
 * @param limit  - Maksimum jumlah record yang diambil (default: 100)
 * @param offset - Offset untuk paginasi (default: 0)
 * @returns Array of ProcessedOrderRecord
 */
export function getProcessedOrders(
  limit = 100,
  offset = 0,
): ProcessedOrderRecord[] {
  return getDb()
    .prepare(
      `SELECT
         id,
         shop_name    AS shopName,
         resi,
         variant,
         processed_at AS processedAt,
         batch_text   AS batchText,
         row_number   AS rowNumber
       FROM processed_orders
       ORDER BY processed_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as ProcessedOrderRecord[];
}

/**
 * Hitung total order yang tersimpan di DB.
 * Digunakan untuk menampilkan statistik dan info paginasi.
 *
 * @returns Jumlah total record di tabel processed_orders
 */
export function getProcessedCount(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS count FROM processed_orders')
    .get() as { count: number };
  return row.count;
}

/**
 * Hapus satu record order dari DB untuk memungkinkan re-processing.
 * Digunakan ketika operator ingin memproses ulang order tertentu.
 *
 * @param id - ID record yang akan dihapus (dari kolom id)
 * @returns true jika berhasil dihapus, false jika ID tidak ditemukan
 */
export function removeProcessedOrder(id: number): boolean {
  const result = getDb()
    .prepare('DELETE FROM processed_orders WHERE id = ?')
    .run(id);

  if (result.changes > 0) {
    logger.info('DB', `Removed record ID ${id} — order can now be re-processed`);
    return true;
  }

  return false;
}

/**
 * Hapus SEMUA record dari tabel processed_orders (factory reset DB).
 * Operasi ini tidak bisa dibatalkan — gunakan dengan hati-hati.
 *
 * @returns Jumlah record yang dihapus
 */
export function clearAllProcessed(): number {
  const result = getDb()
    .prepare('DELETE FROM processed_orders')
    .run();

  logger.warn('DB', `Cleared all processed orders — ${result.changes} records deleted`);
  return result.changes;
}

// ─── Config Persistence ──────────────────────────────────────────────────────

/**
 * Baca nilai konfigurasi persistent dari DB.
 * Mengembalikan string kosong jika key tidak ditemukan.
 *
 * @param key - Nama konfigurasi (contoh: 'date_from', 'date_to')
 * @returns Nilai konfigurasi, atau '' jika tidak ada
 */
export function getDbConfig(key: string): string {
  const row = getDb()
    .prepare('SELECT value FROM worker_config WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? '';
}

/**
 * Tulis nilai konfigurasi persistent ke DB.
 * Menggunakan INSERT OR REPLACE sehingga otomatis update jika key sudah ada.
 *
 * @param key   - Nama konfigurasi
 * @param value - Nilai yang akan disimpan
 */
export function setDbConfig(key: string, value: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO worker_config(key, value) VALUES (?, ?)')
    .run(key, value);
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Tutup koneksi database dengan aman.
 * Dipanggil saat worker shutdown untuk memastikan WAL di-flush ke disk.
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('DB', 'Database connection closed');
  }
}
