/**
 * driveService.ts — Google Drive operations for the Worker.
 *
 * Responsibilities:
 * - List date folders & order folders
 * - Check if output PDF already exists (anti-duplicate)
 * - Download images from order folder
 * - Upload generated PDF back to Drive
 * - Count images without downloading (pre-validation)
 * - Move folders between parents (Phase 2 migration)
 * - Rename folders (Phase 2 migration)
 * - Create folders if not exist
 * - Find folders by name
 */
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { getDriveClient } from './googleAuth.ts';
import { buildOutputFileName } from '../utils/folderParser.ts';
import { logger } from '../utils/logger.ts';
import type { DriveFolder, DriveFile } from '../types.ts';

const MIME_FOLDER = 'application/vnd.google-apps.folder';
const MIME_IMAGES = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg', 'image/heic', 'image/heif'];

/**
 * List all subfolders inside a given folder.
 */
export async function listSubfolders(parentFolderId: string): Promise<DriveFolder[]> {
  const drive = getDriveClient();
  const folders: DriveFolder[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q: `'${parentFolderId}' in parents and mimeType = '${MIME_FOLDER}' and trashed = false`,
      fields: 'nextPageToken, files(id, name, modifiedTime)',
      orderBy: 'name',
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    if (res.data.files) {
      for (const f of res.data.files) {
        if (f.id && f.name) {
          folders.push({
            id: f.id,
            name: f.name,
            modifiedTime: f.modifiedTime || undefined,
          });
        }
      }
    }
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  return folders;
}

/**
 * List all image files inside a folder (non-recursive).
 * Includes modifiedTime for stale detection.
 */
export async function listImageFiles(folderId: string): Promise<DriveFile[]> {
  const drive = getDriveClient();
  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  const mimeQuery = MIME_IMAGES.map(m => `mimeType = '${m}'`).join(' or ');

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and (${mimeQuery}) and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)',
      orderBy: 'name',
      pageSize: 200,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    if (res.data.files) {
      for (const f of res.data.files) {
        if (f.id && f.name && f.mimeType) {
          files.push({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            size: f.size ? parseInt(f.size, 10) : undefined,
            modifiedTime: f.modifiedTime || undefined,
          });
        }
      }
    }
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  return files;
}

/**
 * Inspect a folder: count images + find the latest modified time.
 * Single API call that provides everything needed for stale detection.
 *
 * Returns:
 *   - count: number of images
 *   - lastModifiedAt: Date of the most recently modified image (or null)
 *   - minutesSinceLastUpload: how many minutes since the latest image was modified
 */
export interface FolderInspection {
  count: number;
  lastModifiedAt: Date | null;
  minutesSinceLastUpload: number | null;
}

export async function inspectFolder(folderId: string): Promise<FolderInspection> {
  const files = await listImageFiles(folderId);

  if (files.length === 0) {
    return { count: 0, lastModifiedAt: null, minutesSinceLastUpload: null };
  }

  // Find the most recently modified file
  let latestTime: Date | null = null;
  for (const f of files) {
    if (f.modifiedTime) {
      const t = new Date(f.modifiedTime);
      if (!latestTime || t > latestTime) {
        latestTime = t;
      }
    }
  }

  const minutesSinceLastUpload = latestTime
    ? Math.round((Date.now() - latestTime.getTime()) / 60_000)
    : null;

  return {
    count: files.length,
    lastModifiedAt: latestTime,
    minutesSinceLastUpload,
  };
}

/**
 * Count images in a folder without downloading them.
 * Simple wrapper — use inspectFolder() if you also need stale info.
 */
export async function countImagesInFolder(folderId: string): Promise<number> {
  const files = await listImageFiles(folderId);
  return files.length;
}

/**
 * Check if a file with the expected output name already exists in a folder.
 * This is the primary anti-duplicate mechanism (Layer 1).
 */
export async function checkOutputExists(dateFolderId: string, resi: string, variant: number): Promise<boolean> {
  const drive = getDriveClient();
  const expectedName = buildOutputFileName(resi, variant);

  const res = await drive.files.list({
    q: `'${dateFolderId}' in parents and name = '${expectedName}' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  return (res.data.files?.length ?? 0) > 0;
}

/**
 * Download all images from a Drive folder to a local temp directory.
 * Returns array of local file paths, sorted by name.
 */
export async function downloadImages(folderId: string, destDir: string): Promise<string[]> {
  const files = await listImageFiles(folderId);
  if (files.length === 0) return [];

  // Ensure dest directory exists
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const localPaths: string[] = [];

  for (const file of files) {
    const destPath = path.join(destDir, file.name);

    try {
      const drive = getDriveClient();
      const res = await drive.files.get(
        { fileId: file.id, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' }
      );

      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(destPath);
        (res.data as Readable)
          .pipe(writeStream)
          .on('finish', resolve)
          .on('error', reject);
      });

      localPaths.push(destPath);
    } catch (err: any) {
      logger.error('DRIVE', `Failed to download ${file.name}: ${err.message}`);
      // Continue with other files — don't stop entire batch for one file
    }
  }

  // Sort by filename for consistent ordering
  localPaths.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  return localPaths;
}

/**
 * Upload a PDF file to a specific folder in Google Drive.
 */
export async function uploadPDF(
  parentFolderId: string,
  localFilePath: string,
  fileName: string
): Promise<string> {
  const drive = getDriveClient();

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [parentFolderId],
      mimeType: 'application/pdf',
    },
    media: {
      mimeType: 'application/pdf',
      body: fs.createReadStream(localFilePath),
    },
    fields: 'id',
    supportsAllDrives: true,
  });

  const fileId = res.data.id;
  if (!fileId) throw new Error('Upload succeeded but no file ID returned');

  logger.success('DRIVE', `Uploaded ${fileName} (ID: ${fileId})`);
  return fileId;
}

/**
 * List all files in a folder (both images and PDFs) for comprehensive checking.
 */
export async function listAllFiles(folderId: string): Promise<DriveFile[]> {
  const drive = getDriveClient();
  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size)',
      orderBy: 'name',
      pageSize: 200,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    if (res.data.files) {
      for (const f of res.data.files) {
        if (f.id && f.name && f.mimeType) {
          files.push({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            size: f.size ? parseInt(f.size, 10) : undefined,
          });
        }
      }
    }
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  return files;
}

// ─── PHASE 2: Migration Operations ─────────────────────────────────────────

/**
 * Find a folder by exact name inside a parent folder.
 * Returns the folder if found, null otherwise.
 */
export async function findFolderByName(
  parentFolderId: string,
  folderName: string
): Promise<DriveFolder | null> {
  // First try exact match via API (fastest)
  const drive = getDriveClient();

  const exactRes = await drive.files.list({
    q: `'${parentFolderId}' in parents and mimeType = '${MIME_FOLDER}' and name = '${folderName}' and trashed = false`,
    fields: 'files(id, name, modifiedTime)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (exactRes.data.files && exactRes.data.files.length > 0) {
    const f = exactRes.data.files[0];
    if (f.id && f.name) {
      return { id: f.id, name: f.name, modifiedTime: f.modifiedTime || undefined };
    }
  }

  // Fallback: list all subfolders and match case-insensitively
  const allFolders = await listSubfolders(parentFolderId);
  const targetLower = folderName.toLowerCase();

  // Try exact case-insensitive match
  const ciMatch = allFolders.find(f => f.name.toLowerCase() === targetLower);
  if (ciMatch) {
    logger.debug('DRIVE', `Found "${ciMatch.name}" via case-insensitive match (searched: "${folderName}")`);
    return ciMatch;
  }

  // Try contains match (e.g., "CustomeBase" matches "Toko CustomeBase")
  const containsMatch = allFolders.find(f => f.name.toLowerCase().includes(targetLower));
  if (containsMatch) {
    logger.debug('DRIVE', `Found "${containsMatch.name}" via contains match (searched: "${folderName}")`);
    return containsMatch;
  }

  // Try reverse contains (e.g., "Toko CustomeBase" matches folder named "CustomeBase")
  const reverseMatch = allFolders.find(f => targetLower.includes(f.name.toLowerCase()));
  if (reverseMatch) {
    logger.debug('DRIVE', `Found "${reverseMatch.name}" via reverse-contains match (searched: "${folderName}")`);
    return reverseMatch;
  }

  return null;
}

/**
 * Create a new folder inside a parent folder.
 * Returns the created folder's ID.
 */
export async function createFolder(
  parentFolderId: string,
  folderName: string
): Promise<DriveFolder> {
  const drive = getDriveClient();

  const res = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: MIME_FOLDER,
      parents: [parentFolderId],
    },
    fields: 'id, name',
    supportsAllDrives: true,
  });

  if (!res.data.id || !res.data.name) {
    throw new Error(`Failed to create folder "${folderName}"`);
  }

  logger.success('DRIVE', `Created folder: ${folderName} (ID: ${res.data.id})`);
  return { id: res.data.id, name: res.data.name };
}

/**
 * Find a folder by name, or create it if it doesn't exist.
 */
export async function findOrCreateFolder(
  parentFolderId: string,
  folderName: string
): Promise<DriveFolder> {
  const existing = await findFolderByName(parentFolderId, folderName);
  if (existing) return existing;
  return createFolder(parentFolderId, folderName);
}

/**
 * Move a file/folder from one parent to another.
 * This is an atomic operation in Google Drive — the file is NOT duplicated.
 */
export async function moveFile(
  fileId: string,
  currentParentId: string,
  newParentId: string
): Promise<void> {
  const drive = getDriveClient();

  // Fetch current parents to ensure we remove ALL of them. 
  // This avoids "Increasing the number of parents is not allowed" on Shared Drives.
  const file = await drive.files.get({
    fileId,
    fields: 'parents',
    supportsAllDrives: true,
  });

  const currentParents = file.data.parents || [];
  
  if (currentParents.includes(newParentId)) {
    logger.debug('DRIVE', `File ${fileId} already has parent ${newParentId}, skipping move.`);
    return;
  }

  const removeParents = currentParents.join(',');

  const removeParentsStr = removeParents || currentParentId;
  
  logger.debug('DRIVE', `[moveFile] fileId=${fileId}, addParents=${newParentId}, removeParents=${removeParentsStr}, currentParents=${JSON.stringify(currentParents)}`);

  await drive.files.update({
    fileId,
    addParents: newParentId,
    removeParents: removeParentsStr,
    fields: 'id, parents',
    supportsAllDrives: true,
    enforceSingleParent: true,
  });

  logger.info('DRIVE', `Moved file ${fileId} to ${newParentId}`);
}

/**
 * Rename a file/folder in Google Drive.
 */
export async function renameFile(fileId: string, newName: string): Promise<void> {
  const drive = getDriveClient();

  await drive.files.update({
    fileId,
    requestBody: { name: newName },
    fields: 'id, name',
    supportsAllDrives: true,
  });

  logger.info('DRIVE', `Renamed file ${fileId} to "${newName}"`);
}
