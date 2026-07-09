/**
 * types.ts — Shared TypeScript interfaces for the AutoCollage Worker.
 *
 * Semua tipe data yang digunakan lintas modul didefinisikan di sini
 * untuk menjaga konsistensi dan memudahkan refactoring.
 */

// ─── Google Drive Structures ────────────────────────────────────────────────

export interface DriveFolder {
  id: string;
  name: string;
  modifiedTime?: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  md5Checksum?: string;
  width?: number;
  height?: number;
}

// ─── Shop Configuration ─────────────────────────────────────────────────────

/**
 * Column mapping for the FOTO POLAROID sheet.
 * Columns B, G, H, J are fixed across all shops.
 * EDITOR column varies per shop (auto-detected from header row).
 */
export interface ShopColumnMapping {
  /** Column letter for Status (e.g., "N") — auto-detected */
  statusCol: string;
  /** Column letter for Dikerjakan BOT (e.g., "O") — auto-detected */
  botCol: string;
  /** Column letter for Upload Batch (e.g., "P") — auto-detected */
  batchCol: string;
}

/**
 * Configuration for a single shop/toko.
 * Each shop has its own Drive folder and spreadsheet.
 */
export interface ShopConfig {
  /** Display name for the shop (e.g., "CustomeBase") */
  name: string;
  /** Google Spreadsheet ID for this shop */
  spreadsheetId: string;
  /** Sheet name containing order data (default: "FOTO POLAROID") */
  sheetName: string;
  /** Name of the product folder to scan inside the shop folder (default: "POLAROID") */
  polaroidFolderName: string;
  /** Name of the fallback/alternative folder to scan (default: "LAINNYA") */
  lainnyaFolderName?: string;
  /** Column mapping — auto-detected at runtime, but can be overridden */
  columns?: ShopColumnMapping;
}

/**
 * Runtime-resolved shop info (after scanning Drive).
 * Contains the Drive folder IDs discovered during scan.
 */
export interface ResolvedShop extends ShopConfig {
  /** Drive folder ID for the shop folder (discovered from root) */
  shopFolderId: string;
  /** Drive folder ID for the POLAROID subfolder (discovered from shop folder) */
  polaroidFolderId: string;
  /** Drive folder ID for the LAINNYA subfolder (if found) */
  lainnyaFolderId?: string;
  /** Auto-detected column mapping from spreadsheet header */
  columns: ShopColumnMapping;
}

// ─── Parsed Order Info ──────────────────────────────────────────────────────

export interface ParsedOrder {
  /** Nomor resi, e.g., "JX9171527480" */
  resi: string;
  /** Jumlah foto yang diharapkan per copy, e.g., 25 */
  variant: number;
  /** Nama folder asli di Drive */
  rawFolderName: string;
}

// ─── Spreadsheet: FOTO POLAROID ─────────────────────────────────────────────

export interface SheetOrderData {
  /** Row number (1-indexed) di spreadsheet */
  rowNumber: number;
  /** Nomor resi dari kolom B */
  resi: string;
  /** Variant dari kolom G (e.g., "25 Pcs") — angka yang diekstrak */
  variant: number;
  /** Qty dari kolom H — jumlah copy */
  qty: number;
  /** Total foto yang diharapkan (variant × qty) */
  expectedPhotos: number;
  /** Status transaksi dari kolom J */
  status: string;
  /** Value of Kolom Status (N) */
  botStatusValue: string;
  /** Value of DIKERJAKAN BOT column (empty = not done, "DONE" = already processed) */
  botValue: string;
  /** Tanggal order dari Kolom A (raw string, format DD-MM-YYYY) */
  orderDate: string;
}

export interface ValidationResult {
  valid: boolean;
  order?: SheetOrderData;
  reason?: string;
}

// ─── Processing Job ─────────────────────────────────────────────────────────

export type JobStatus = 'queued' | 'downloading' | 'validating' | 'generating' | 'uploading' | 'marking' | 'done' | 'skipped' | 'error';

export interface ProcessingJob {
  id: string;
  resi: string;
  variant: number;
  qty: number;
  /** Name of the shop this job belongs to */
  shopName: string;
  /** Drive folder ID of the order folder */
  orderFolderId: string;
  status: JobStatus;
  message: string;
  startedAt: number;
  completedAt?: number;
  /** Progress percentage 0-100 */
  progress: number;
}

// ─── Worker State (untuk Dashboard API) ────────────────────────────────────

export type WorkerStatus = 'running' | 'stopped' | 'scanning' | 'idle';

export interface WorkerState {
  status: WorkerStatus;
  startedAt: number | null;
  lastScanAt: number | null;
  nextScanAt: number | null;
  pollIntervalMinutes: number;
  maxConcurrency: number;
  /** Total orders processed since start */
  totalProcessed: number;
  /** Total errors since start */
  totalErrors: number;
  /** Total skipped since start */
  totalSkipped: number;
  /** Currently active jobs */
  activeJobs: ProcessingJob[];
  /** History of completed/failed jobs (last 100) */
  history: ProcessingJob[];
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface WorkerConfig {
  googleCredentialsPath: string;
  googleTokenPath: string;
  /** Root PESANAN folder ID containing all shop folders */
  driveRootFolderId: string;
  /** Array of shop configurations */
  shops: ShopConfig[];
  /** Text to write in the UPLOAD BATCH column (configurable via dashboard dropdown) */
  batchText: string;
  pollIntervalMinutes: number;
  maxConcurrency: number;
  /** Minutes after last upload to consider an incomplete order as "stale" (ready to process) */
  staleTimeoutMinutes: number;
  tempDir: string;
  enableFaceDetection: boolean;
  dryRun: boolean;
  serverPort: number;
  /** Secondary Drive folder for uploading finished PDFs */
  secondaryDriveFolderId?: string;
  /** Path ke file SQLite database untuk persistent order tracking */
  dbPath: string;
  /**
   * Filter tanggal: hanya proses order pada/setelah tanggal ini.
   * Format: YYYY-MM-DD (standard HTML date input).
   * Jika kosong/undefined → tidak ada batas bawah (semua tanggal lama diproses).
   * Disimpan persisten di DB, di-load saat boot.
   */
  dateFrom?: string;
  /**
   * Filter tanggal: hanya proses order pada/sebelum tanggal ini.
   * Format: YYYY-MM-DD (standard HTML date input).
   * Jika kosong/undefined → tidak ada batas atas (semua tanggal baru diproses).
   * Disimpan persisten di DB, di-load saat boot.
   */
  dateTo?: string;
}

// ─── Database Records ───────────────────────────────────────────────────────

/**
 * Representasi satu baris dari tabel processed_orders di SQLite.
 * Digunakan untuk API response dan tampilan di dashboard.
 */
export interface ProcessedOrderRecord {
  /** Primary key auto-increment */
  id: number;
  /** Nama toko (CUSTOMBASE, GIFTYOURS, VENTURA) */
  shopName: string;
  /** Nomor resi order */
  resi: string;
  /** Jumlah foto variant (25, 50, 100, dll.) */
  variant: number;
  /** Unix timestamp (ms) kapan order ini selesai diproses */
  processedAt: number;
  /** Label batch yang digunakan saat pemrosesan */
  batchText: string;
  /** Nomor baris di spreadsheet */
  rowNumber: number;
}

// ─── Logger ─────────────────────────────────────────────────────────────────

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS' | 'DEBUG';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
}
