/**
 * zipExtractor.ts — Browser-side ZIP extraction utility.
 *
 * Extracts image files from a ZIP archive and converts them to standard
 * File objects with synthetic `webkitRelativePath`, making them fully
 * compatible with the existing folder-based pipeline.
 *
 * Features:
 * - Uses fflate (8kB, fastest JS decompressor)
 * - Filters junk files (__MACOSX, .DS_Store, Thumbs.db, etc.)
 * - Preserves internal folder structure via synthetic paths
 * - Handles flat ZIPs (no folders) by using ZIP filename as group
 * - Progress callback for UI feedback
 * - File size validation (max 500MB)
 * - Corrupt ZIP detection with clear error messages
 */
import { unzipSync } from 'fflate';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ZIP_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB

/** Extensions recognized as images (lowercase, with dot) */
export const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.jpe', '.jfif',
  '.png', '.webp', '.heic', '.heif',
  '.bmp', '.tiff', '.tif', '.gif', '.avif', '.svg',
]);

/** Paths/filenames to always skip */
const JUNK_PATTERNS = [
  '__MACOSX',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.BridgeSort',
  '._.', // macOS resource fork prefix
];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ZipExtractionProgress {
  /** Current phase: 'reading' | 'decompressing' | 'converting' */
  phase: 'reading' | 'decompressing' | 'converting';
  /** 0–100 percentage */
  percent: number;
  /** Human-readable status message */
  message: string;
}

export interface ZipExtractionResult {
  /** Extracted image files, ready for handleFolderSelect pipeline */
  files: File[];
  /** Total entries found in ZIP (before filtering) */
  totalEntries: number;
  /** Number of entries that were images */
  imageCount: number;
  /** Number of entries skipped (junk, non-image) */
  skippedCount: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get the file extension from a filename (lowercase, with dot).
 */
function getExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1 || dotIndex === filename.length - 1) return '';
  return filename.slice(dotIndex).toLowerCase();
}

/**
 * Check if a file path represents an image based on extension.
 */
function isImageFile(filepath: string): boolean {
  const ext = getExtension(filepath);
  return SUPPORTED_IMAGE_EXTENSIONS.has(ext);
}

export function isSupportedImageFileName(filename: string): boolean {
  return isImageFile(filename);
}

/**
 * Check if a path should be skipped (junk files/folders).
 */
function isJunkPath(filepath: string): boolean {
  return JUNK_PATTERNS.some(pattern => filepath.includes(pattern));
}

/**
 * Check if a path is a directory entry (trailing slash, or empty content).
 */
function isDirectoryEntry(filepath: string): boolean {
  return filepath.endsWith('/');
}

/**
 * Map file extension → MIME type for the File constructor.
 */
function getMimeType(filename: string): string {
  const ext = getExtension(filename);
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.jpe': 'image/jpeg',
    '.jfif': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.gif': 'image/gif',
    '.avif': 'image/avif',
    '.svg': 'image/svg+xml',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

/**
 * Get just the filename from a full path inside the ZIP.
 * e.g., "folder/subfolder/photo.jpg" → "photo.jpg"
 */
function getBasename(filepath: string): string {
  const parts = filepath.split('/');
  return parts[parts.length - 1];
}

/**
 * Strip the root ZIP filename from the path prefix to build a clean
 * webkitRelativePath. Uses the ZIP file's own name as the root.
 *
 * ZIP internal:  "CustomerA/sub/photo.jpg"
 * ZIP filename:  "upload.zip"
 * Result path:   "CustomerA/sub/photo.jpg" (keep as-is, internal structure)
 *
 * Flat ZIP:      "photo.jpg" (no folder)
 * ZIP filename:  "CustomerA.zip"
 * Result path:   "CustomerA/photo.jpg" (use ZIP name as root)
 */
function buildSyntheticPath(
  zipEntryPath: string,
  zipRootName: string,
  isFlat: boolean,
): string {
  if (isFlat) {
    // Flat ZIP: use ZIP filename as virtual folder
    return `${zipRootName}/${zipEntryPath}`;
  }
  // Structured ZIP: keep internal path as-is
  return zipEntryPath;
}

/**
 * Create a File object from raw data with a synthetic webkitRelativePath.
 * We use Object.defineProperty because webkitRelativePath is read-only
 * on the native File object.
 */
function createFileWithPath(
  data: Uint8Array,
  filename: string,
  mimeType: string,
  syntheticPath: string,
): File {
  const file = new File([data], filename, {
    type: mimeType,
    lastModified: Date.now(),
  });

  // Attach synthetic webkitRelativePath (read-only on native, so we redefine)
  Object.defineProperty(file, 'webkitRelativePath', {
    value: syntheticPath,
    writable: false,
    enumerable: true,
    configurable: true,
  });

  return file;
}

// ─── Main Extraction Function ─────────────────────────────────────────────────

/**
 * extractZip — Extract all image files from a ZIP archive.
 *
 * Converts ZIP entries to standard File objects with synthetic
 * webkitRelativePath, so the existing handleFolderSelect pipeline
 * works with zero modifications.
 *
 * @param zipFile - The ZIP File object from <input> or drag & drop
 * @param onProgress - Optional callback for progress updates
 * @returns Promise<ZipExtractionResult> with File[] ready for processing
 * @throws Error if ZIP is too large, corrupt, or contains no images
 */
export async function extractZip(
  zipFile: File,
  onProgress?: (progress: ZipExtractionProgress) => void,
): Promise<ZipExtractionResult> {
  // ── Validation ──────────────────────────────────────────────────────
  if (zipFile.size > MAX_ZIP_SIZE_BYTES) {
    const sizeMB = (zipFile.size / 1024 / 1024).toFixed(0);
    throw new Error(
      `File ZIP terlalu besar (${sizeMB} MB). Maksimal ${MAX_ZIP_SIZE_BYTES / 1024 / 1024} MB.`,
    );
  }

  if (!zipFile.name.toLowerCase().endsWith('.zip')) {
    throw new Error('File yang dipilih bukan ZIP. Harap pilih file .zip');
  }

  // ── Phase 1: Read ZIP as ArrayBuffer ────────────────────────────────
  onProgress?.({
    phase: 'reading',
    percent: 10,
    message: `Membaca ${zipFile.name}...`,
  });

  let arrayBuffer: ArrayBuffer;
  try {
    arrayBuffer = await zipFile.arrayBuffer();
  } catch {
    throw new Error('Gagal membaca file ZIP. File mungkin rusak atau tidak bisa diakses.');
  }

  const zipData = new Uint8Array(arrayBuffer);

  // ── Phase 2: Decompress ─────────────────────────────────────────────
  onProgress?.({
    phase: 'decompressing',
    percent: 30,
    message: 'Mengekstrak ZIP...',
  });

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipData);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`ZIP rusak atau tidak valid: ${message}`);
  }

  // ── Phase 3: Convert entries to File objects ─────────────────────────
  const allPaths = Object.keys(entries);
  const totalEntries = allPaths.length;

  // Filter to only image files (skip directories, junk, non-images)
  const imagePaths = allPaths.filter(
    path => !isDirectoryEntry(path) && !isJunkPath(path) && isImageFile(path),
  );

  if (imagePaths.length === 0) {
    throw new Error(
      'Tidak ada gambar ditemukan di dalam ZIP. ' +
      'Pastikan ZIP berisi file gambar (.jpg, .png, .heic, .webp, dll).',
    );
  }

  // Detect if ZIP is flat (no folder structure) or structured
  const hasSubfolders = imagePaths.some(p => p.includes('/'));

  // Build root name from ZIP filename (strip .zip extension)
  const zipRootName = zipFile.name.replace(/\.zip$/i, '');

  const files: File[] = [];
  const skippedCount = totalEntries - imagePaths.length;

  for (let i = 0; i < imagePaths.length; i++) {
    const entryPath = imagePaths[i];
    const data = entries[entryPath];

    // Skip empty entries
    if (!data || data.length === 0) continue;

    const filename = getBasename(entryPath);
    const mimeType = getMimeType(filename);
    const syntheticPath = buildSyntheticPath(entryPath, zipRootName, !hasSubfolders);

    const file = createFileWithPath(data, filename, mimeType, syntheticPath);
    files.push(file);

    // Progress update every ~10% or every 5 files (whichever is more frequent)
    if (i % Math.max(1, Math.floor(imagePaths.length / 20)) === 0 || i === imagePaths.length - 1) {
      const percent = 30 + Math.round(((i + 1) / imagePaths.length) * 70);
      onProgress?.({
        phase: 'converting',
        percent,
        message: `Memproses ${filename} (${i + 1}/${imagePaths.length})...`,
      });
    }
  }

  // Sort by synthetic path for consistent ordering
  files.sort((a, b) => {
    const pathA = (a as unknown as { webkitRelativePath: string }).webkitRelativePath;
    const pathB = (b as unknown as { webkitRelativePath: string }).webkitRelativePath;
    return pathA.localeCompare(pathB);
  });

  return {
    files,
    totalEntries,
    imageCount: files.length,
    skippedCount,
  };
}

// ─── Validation Helpers (exported for UI use) ─────────────────────────────────

/**
 * Check if a File/DataTransferItem is a ZIP file.
 */
export function isZipFile(file: File | DataTransferItem): boolean {
  if ('name' in file) {
    return (file as File).name.toLowerCase().endsWith('.zip');
  }
  return file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
}

/**
 * Maximum allowed ZIP size in bytes.
 */
export const ZIP_MAX_SIZE = MAX_ZIP_SIZE_BYTES;
