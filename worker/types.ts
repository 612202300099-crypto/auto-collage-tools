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
}

// ─── Shop Configuration ─────────────────────────────────────────────────────

/**
 * Column mapping for the FOTO POLAROID sheet.
 * Columns B, G, H, J are fixed across all shops.
 * EDITOR column varies per shop (auto-detected from header row).
 */
export interface ShopColumnMapping {
  /** Column letter for EDITOR (e.g., "M" or "N") — auto-detected */
  editor: string;
  /** Column letter for editor text (column after EDITOR) — auto-detected */
  editorText: string;
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
  /** Value of EDITOR column (empty = not done, any value = already processed) */
  editorValue: string;
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
  /** Text to write in the column after EDITOR (configurable via dashboard) */
  editorText: string;
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
}

// ─── Logger ─────────────────────────────────────────────────────────────────

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS' | 'DEBUG';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
}
