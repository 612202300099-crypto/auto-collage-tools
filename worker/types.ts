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
}

// ─── Date Folder Classification ─────────────────────────────────────────────

export type DateFolderType = 'DD_MM_YYYY' | 'YYYY_MM_DD' | 'UNKNOWN';

export interface ClassifiedDateFolder extends DriveFolder {
  type: DateFolderType;
}

// ─── Parsed Order Info ──────────────────────────────────────────────────────

export interface ParsedOrder {
  /** Nomor resi, e.g., "JX9171527480" */
  resi: string;
  /** Jumlah foto yang diharapkan, e.g., 25 */
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
  /** Qty dari kolom H — jumlah copy/pages */
  qty: number;
  /** Status transaksi dari kolom J */
  status: string;
  /** Apakah kolom K (VARIAN) sudah terisi "done" */
  isDone: boolean;
}

export interface ValidationResult {
  valid: boolean;
  order?: SheetOrderData;
  reason?: string;
}

// ─── Spreadsheet: EKSPORT ───────────────────────────────────────────────────

export interface EksportOrderData {
  /** Row number (1-indexed) di sheet EKSPORT */
  rowNumber: number;
  /** Platform unique order ID (Kolom C) */
  orderIdPlatform: string;
  /** Variation dari Kolom K (e.g., "100 Pcs") — angka yang diekstrak */
  variant: number;
  /** Qty dari Kolom L */
  qty: number;
  /** Total foto yang diharapkan (variant × qty) */
  expectedPhotos: number;
  /** Tracking ID / Resi (Kolom AP) */
  resi: string;
}

// ─── Processing Job ─────────────────────────────────────────────────────────

export type JobStatus = 'queued' | 'downloading' | 'validating' | 'generating' | 'uploading' | 'marking' | 'moving' | 'done' | 'skipped' | 'error';

export interface ProcessingJob {
  id: string;
  resi: string;
  variant: number;
  dateFolderName: string;
  dateFolderId: string;
  orderFolderId: string;
  status: JobStatus;
  message: string;
  startedAt: number;
  completedAt?: number;
  qty: number;
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
  driveRootFolderId: string;
  spreadsheetId: string;
  sheetName: string;
  eksportSheetName: string;
  pollIntervalMinutes: number;
  maxConcurrency: number;
  tempDir: string;
  enableFaceDetection: boolean;
  dryRun: boolean;
  serverPort: number;
  secondaryDriveFolderId?: string;
  targetDateFilter: string;
}

// ─── Logger ─────────────────────────────────────────────────────────────────

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS' | 'DEBUG';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
}
