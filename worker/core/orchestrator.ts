/**
 * orchestrator.ts — Main automation loop for the Worker.
 *
 * This is the brain of the system. It coordinates:
 *
 * ── PHASE 1 (Priority): DD-MM-YYYY Folders ──
 * 1. Scan folders formatted DD-MM-YYYY (e.g., "25-04-2026")
 * 2. Process subfolders that already have resi names (JX****_100 Pcs)
 * 3. Validate → Download → Generate PDF → Upload → Mark "done" in Col K
 *
 * ── PHASE 2 (Migration): YYYY-MM-DD Folders ──
 * 4. Scan folders formatted YYYY-MM-DD (e.g., "2026-04-24")
 * 5. For each subfolder, lookup resi from EKSPORT sheet (Col AP)
 * 6. Move subfolder to corresponding DD-MM-YYYY folder
 * 7. Rename subfolder to "JX****_variant Pcs"
 * 8. The moved folder will be processed in the NEXT scan cycle (Phase 1)
 *
 * All with multi-layer anti-duplicate protection.
 */
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.ts';
import {
  parseFolderName,
  buildOutputFileName,
  classifyDateFolders,
  convertYyyyMmDdToDdMmYyyy,
  convertDdMmYyyyToYyyyMmDd,
  buildOrderFolderName,
  extractVariantFromText,
} from '../utils/folderParser.ts';
import { generateRandomBatchColor } from './colorUtils';
import * as driveService from '../services/driveService.ts';
import * as sheetsService from '../services/sheetsService.ts';
import { generatePDF } from '../engine/pdfEngine.ts';
import { WorkerPool } from './workerPool.ts';
import * as state from './stateManager.ts';
import type { WorkerConfig, ParsedOrder, ClassifiedDateFolder } from '../types.ts';

let isRunning = false;
let scanTimer: ReturnType<typeof setTimeout> | null = null;
let pool: WorkerPool | null = null;
let currentConfig: WorkerConfig | null = null;

// ─── PUBLIC CONTROL API ──────────────────────────────────────────────────────

export function start(config: WorkerConfig): void {
  if (isRunning) {
    logger.warn('ORCH', 'Worker is already running');
    return;
  }

  currentConfig = config;
  isRunning = true;
  pool = new WorkerPool(config.maxConcurrency);

  state.setStarted(config.pollIntervalMinutes, config.maxConcurrency);
  logger.success('ORCH', `Worker STARTED — Polling every ${config.pollIntervalMinutes} min, Max concurrency: ${config.maxConcurrency}`);

  // Run immediately, then schedule
  runScanCycle();
}

export function stop(): void {
  if (!isRunning) {
    logger.warn('ORCH', 'Worker is not running');
    return;
  }

  isRunning = false;
  if (scanTimer) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }

  state.setStopped();
  logger.info('ORCH', 'Worker STOPPED — Active jobs will complete but no new scans will start');
}

export function isWorkerRunning(): boolean {
  return isRunning;
}

export function updateConcurrency(n: number): void {
  if (pool) {
    pool.setMaxConcurrency(n);
    logger.info('ORCH', `Concurrency updated to ${n}`);
  }
}

export function forceScan(): void {
  if (!isRunning) {
    logger.warn('ORCH', 'Cannot force scan: worker is stopped');
    return;
  }
  logger.info('ORCH', 'Force scan triggered');
  runScanCycle();
}

// ─── SCAN CYCLE ──────────────────────────────────────────────────────────────

async function runScanCycle(): Promise<void> {
  if (!isRunning || !currentConfig) return;

  state.setStatus('scanning');
  state.setLastScan();
  logger.info('ORCH', '━━━ Starting scan cycle ━━━');

  try {
    await scanAndProcessAll(currentConfig);
  } catch (err: any) {
    logger.error('ORCH', `Scan cycle error: ${err.message}`);
  }

  // Schedule next scan
  if (isRunning && currentConfig) {
    const intervalMs = currentConfig.pollIntervalMinutes * 60 * 1000;
    const nextScanTime = Date.now() + intervalMs;
    state.setNextScan(nextScanTime);
    state.setStatus('idle');

    logger.info('ORCH', `Next scan in ${currentConfig.pollIntervalMinutes} minutes`);
    scanTimer = setTimeout(() => runScanCycle(), intervalMs);
  }
}

// ─── MAIN PROCESSING LOGIC ──────────────────────────────────────────────────

async function scanAndProcessAll(config: WorkerConfig): Promise<void> {
  // 1. List all date folders in root
  const allFolders = await driveService.listSubfolders(config.driveRootFolderId);
  const classified = classifyDateFolders(allFolders);

  let ddMmYyyyFolders = classified.filter(f => f.type === 'DD_MM_YYYY');
  let yyyyMmDdFolders = classified.filter(f => f.type === 'YYYY_MM_DD');
  const unknownFolders = classified.filter(f => f.type === 'UNKNOWN');

  if (config.targetDateFilter && config.targetDateFilter !== 'ALL') {
    logger.info('ORCH', `🎯 TARGET DATE FILTER ACTIVE: ${config.targetDateFilter}`);
    
    // Filter DD-MM-YYYY
    ddMmYyyyFolders = ddMmYyyyFolders.filter(f => f.name === config.targetDateFilter);
    
    // Filter YYYY-MM-DD
    try {
      const targetYyyyMmDd = convertDdMmYyyyToYyyyMmDd(config.targetDateFilter);
      yyyyMmDdFolders = yyyyMmDdFolders.filter(f => f.name === targetYyyyMmDd);
    } catch (err: any) {
      logger.warn('ORCH', `Failed to convert target date filter to YYYY-MM-DD: ${err.message}`);
      yyyyMmDdFolders = []; // Invalid target date format, so skip phase 2
    }
  }

  logger.info('ORCH', `Found ${allFolders.length} folder(s): ${ddMmYyyyFolders.length} DD-MM-YYYY, ${yyyyMmDdFolders.length} YYYY-MM-DD, ${unknownFolders.length} unknown`);

  // Generate a batch color for this entire scan cycle
  const batchColor = generateRandomBatchColor();

  // ── PHASE 1: Process DD-MM-YYYY folders (Priority) ──
  logger.info('ORCH', '── PHASE 1: Processing DD-MM-YYYY folders ──');
  for (const dateFolder of ddMmYyyyFolders) {
    if (!isRunning) break;
    await processDdMmYyyyFolder(config, dateFolder, batchColor);
  }

  // ── PHASE 2: Migrate YYYY-MM-DD folders ──
  if (isRunning && yyyyMmDdFolders.length > 0) {
    logger.info('ORCH', '── PHASE 2: Migrating YYYY-MM-DD folders ──');
    for (const dateFolder of yyyyMmDdFolders) {
      if (!isRunning) break;
      await migrateYyyyMmDdFolder(config, dateFolder, batchColor);
    }
  }

  logger.info('ORCH', '━━━ Scan cycle complete ━━━');
}

// ─── PHASE 1: DD-MM-YYYY Processing ─────────────────────────────────────────

/**
 * Process a single DD-MM-YYYY date folder.
 * Subfolders are expected to be named like "JX9195703370_100 Pcs".
 */
async function processDdMmYyyyFolder(
  config: WorkerConfig,
  dateFolder: ClassifiedDateFolder,
  batchColor: string
): Promise<void> {
  logger.info('ORCH', `[P1] Scanning: ${dateFolder.name}`);

  const orderFolders = await driveService.listSubfolders(dateFolder.id);

  // Collect valid tasks for parallel execution
  const tasks: (() => Promise<void>)[] = [];

  for (const orderFolder of orderFolders) {
    const parsed = parseFolderName(orderFolder.name);
    if (!parsed) {
      logger.debug('ORCH', `[P1] Skipping non-order folder: ${orderFolder.name}`);
      continue;
    }

    tasks.push(() =>
      processOrder(config, parsed, dateFolder.id, dateFolder.name, orderFolder.id, batchColor)
    );
  }

  if (tasks.length > 0 && pool) {
    logger.info('ORCH', `[P1] Processing ${tasks.length} order(s) from ${dateFolder.name}`);
    await pool.executeAll(tasks);
  }
}

// ─── PHASE 2: YYYY-MM-DD Migration ─────────────────────────────────────────

/**
 * Migrate subfolders from a YYYY-MM-DD date folder:
 * 1. For each subfolder, lookup order ID in EKSPORT (Col C)
 * 2. Validate variant (Col K) × qty (Col L) = expected photo count
 * 3. Count actual photos and compare
 * 4. Move subfolder to DD-MM-YYYY folder, rename to "JX****_total Pcs"
 * 5. Immediately process (generate PDF → upload → mark done)
 */
async function migrateYyyyMmDdFolder(
  config: WorkerConfig,
  dateFolder: ClassifiedDateFolder,
  batchColor: string
): Promise<void> {
  logger.info('ORCH', `[P2] Scanning: ${dateFolder.name}`);

  const subfolders = await driveService.listSubfolders(dateFolder.id);
  if (subfolders.length === 0) {
    logger.debug('ORCH', `[P2] No subfolders in ${dateFolder.name}`);
    return;
  }

  // Convert YYYY-MM-DD to DD-MM-YYYY for the target folder
  const targetDateName = convertYyyyMmDdToDdMmYyyy(dateFolder.name);

  for (const subfolder of subfolders) {
    if (!isRunning) break;

    // Skip if this folder has a proper RESI name (JX****, JN****, etc.)
    // Folders like "583734596181722839_50 pcs" still have ORDER IDs, not resi — they need processing
    const alreadyParsed = parseFolderName(subfolder.name);
    if (alreadyParsed && /^[A-Z]{2}/i.test(alreadyParsed.resi)) {
      logger.debug('ORCH', `[P2] Skipping already-migrated folder: ${subfolder.name}`);
      continue;
    }

    try {
      await migrateAndProcessSubfolder(config, subfolder, dateFolder, targetDateName, batchColor);
    } catch (err: any) {
      logger.error('ORCH', `[P2] Failed for ${subfolder.name}: ${err.message}`);
    }
  }
}

/**
 * Full pipeline for a single YYYY-MM-DD subfolder:
 * Validate → Move → Rename → Download → Generate PDF → Upload → Mark Done
 */
async function migrateAndProcessSubfolder(
  config: WorkerConfig,
  subfolder: { id: string; name: string },
  sourceFolder: ClassifiedDateFolder,
  targetDateName: string,
  batchColor: string
): Promise<void> {
  // ── Step 1: Lookup order in EKSPORT sheet ──
  const eksportData = await sheetsService.lookupResiFromEksport(
    config.spreadsheetId,
    config.eksportSheetName,
    subfolder.name
  );

  if (!eksportData) {
    logger.warn('ORCH', `[P2] SKIP ${subfolder.name}: Order ID not found in EKSPORT Col C`);
    return;
  }

  const { resi, variant, qty, expectedPhotos } = eksportData;

  if (!resi) {
    logger.warn('ORCH', `[P2] SKIP ${subfolder.name}: No Tracking ID (resi) in EKSPORT Col AP`);
    return;
  }

  if (variant <= 0) {
    logger.warn('ORCH', `[P2] SKIP ${subfolder.name}: Invalid variant in EKSPORT Col K`);
    return;
  }

  logger.info('ORCH', `[P2] Found: ${subfolder.name} → Resi: ${resi}, Variant: ${variant} Pcs, Qty: ${qty}, Expected: ${expectedPhotos} photos`);

  // ── Step 2: Check if already done in FOTO POLAROID ──
  const fotoPolaroidOrder = await sheetsService.findOrderByResi(
    config.spreadsheetId,
    config.sheetName,
    resi
  );

  if (fotoPolaroidOrder && fotoPolaroidOrder.isDone) {
    logger.debug('ORCH', `[P2] SKIP ${subfolder.name}: Resi ${resi} already "done" in FOTO POLAROID`);
    return;
  }

  // ── Step 3: Check if PDF already exists (anti-duplicate) ──
  // Check in the TARGET DD-MM-YYYY folder (where PDF will be uploaded)
  const targetFolderCheck = await driveService.findFolderByName(config.driveRootFolderId, targetDateName);
  if (targetFolderCheck) {
    const pdfExists = await driveService.checkOutputExists(targetFolderCheck.id, resi, expectedPhotos);
    if (pdfExists) {
      logger.debug('ORCH', `[P2] SKIP ${subfolder.name}: PDF already exists in ${targetDateName}`);
      return;
    }
  }

  // ── Step 4: Count photos and validate ──
  const actualPhotoCount = await driveService.countImagesInFolder(subfolder.id);

  if (actualPhotoCount !== expectedPhotos) {
    logger.warn('ORCH', `[P2] SKIP ${subfolder.name}: Photo count mismatch — has ${actualPhotoCount}, expected ${expectedPhotos} (${variant}×${qty})`);
    return;
  }

  logger.info('ORCH', `[P2] ✅ Validated ${subfolder.name}: ${actualPhotoCount}/${expectedPhotos} photos match`);

  // ── DRY RUN ──
  if (config.dryRun) {
    logger.info('ORCH', `[P2] DRY RUN: Would migrate & process ${subfolder.name} → ${targetDateName}/${resi}_${expectedPhotos} Pcs`);
    return;
  }

  // ── Step 5: In-memory lock ──
  if (!state.acquireLock(resi)) {
    logger.debug('ORCH', `[P2] SKIP ${subfolder.name}: Resi ${resi} currently locked`);
    return;
  }

  const job = state.createJob(resi, expectedPhotos, sourceFolder.name, sourceFolder.id, subfolder.id);

  try {
    // ── Step 6: Move folder to DD-MM-YYYY ──
    state.updateJob(job.id, { status: 'moving', message: `Moving to ${targetDateName}...`, progress: 10 });

    const targetFolder = await driveService.findOrCreateFolder(
      config.driveRootFolderId,
      targetDateName
    );

    try {
      await driveService.moveFile(subfolder.id, sourceFolder.id, targetFolder.id);
    } catch (moveErr: any) {
      logger.warn('ORCH', `[P2] Move failed for ${resi} (${moveErr.message}). Processing in place.`);
    }

    // ── Step 7: Rename to resi_total format ──
    let currentFolderName = subfolder.name;
    try {
      const newFolderName = buildOrderFolderName(resi, expectedPhotos);
      await driveService.renameFile(subfolder.id, newFolderName);
      currentFolderName = newFolderName;
      logger.success('ORCH', `[P2] Renamed: ${subfolder.name} → ${newFolderName}`);
    } catch (renameErr: any) {
      logger.warn('ORCH', `[P2] Rename failed for ${resi}: ${renameErr.message}`);
    }

    // ── Step 8: Download images ──
    state.updateJob(job.id, { status: 'downloading', message: 'Downloading images...', progress: 30, dateFolderName: targetDateName, dateFolderId: targetFolder.id });

    const tempDir = path.join(config.tempDir, resi);
    const imagePaths = await driveService.downloadImages(subfolder.id, tempDir);

    if (imagePaths.length === 0) {
      state.completeJob(job.id, 'error', 'Failed to download any images');
      logger.error('ORCH', `[P2] ERROR ${resi}: No images downloaded`);
      return;
    }

    logger.info('ORCH', `[P2] Downloaded ${imagePaths.length} images for ${resi}`);

    // ── Step 9: Generate PDF ──
    state.updateJob(job.id, { status: 'generating', message: 'Generating collage PDF...', progress: 50 });

    const sheetQty = fotoPolaroidOrder?.qty || qty;
    const outputFileName = buildOutputFileName(resi, expectedPhotos);
    const outputPath = path.join(tempDir, outputFileName);

    await generatePDF({
      imagePaths,
      label: resi,
      qty: sheetQty,
      tagColor: batchColor,
      outputPath,
      onProgress: (progressStatus) => {
        state.updateJob(job.id, { message: progressStatus });
      },
    });

    // ── Step 10: Upload PDF ──
    state.updateJob(job.id, { status: 'uploading', message: 'Uploading PDF to Drive...', progress: 80 });

    await driveService.uploadPDF(targetFolder.id, outputPath, outputFileName);
    
    // ── Step 10b: Upload to Secondary Drive if configured ──
    if (config.secondaryDriveFolderId) {
      state.updateJob(job.id, { status: 'uploading', message: 'Uploading PDF to Secondary Drive...', progress: 85 });
      try {
        await driveService.uploadPDF(config.secondaryDriveFolderId, outputPath, outputFileName);
        logger.info('ORCH', `[P2] Uploaded copy to Secondary Drive for ${resi}`);
      } catch (err: any) {
        logger.warn('ORCH', `[P2] Failed to upload to Secondary Drive for ${resi}: ${err.message}`);
        // Do not fail the whole job if secondary upload fails
      }
    }

    // ── Step 11: Mark done in FOTO POLAROID Col K ──
    if (fotoPolaroidOrder) {
      state.updateJob(job.id, { status: 'marking', message: 'Marking "done" in Col K...', progress: 90 });
      await sheetsService.markAsDone(config.spreadsheetId, config.sheetName, fotoPolaroidOrder.rowNumber);
    } else {
      logger.warn('ORCH', `[P2] ${resi}: Resi not found in FOTO POLAROID — PDF uploaded but "done" not marked`);
    }

    // ── Step 12: Cleanup temp files ──
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* non-critical */ }

    state.completeJob(job.id, 'done', `Completed: ${outputFileName} (${sheetQty} pages)`);
    logger.success('ORCH', `[P2] ✅ ${resi}: ${outputFileName} uploaded & marked "done"`);

  } catch (err: any) {
    state.completeJob(job.id, 'error', err.message);
    logger.error('ORCH', `[P2] ERROR ${resi}: ${err.message}`);
  } finally {
    state.releaseLock(resi);
  }
}

// ─── ORDER PROCESSING (Shared by Phase 1) ───────────────────────────────────

/**
 * Process a single order: validate → download → generate → upload → mark done.
 */
async function processOrder(
  config: WorkerConfig,
  parsed: ParsedOrder,
  dateFolderId: string,
  dateFolderName: string,
  orderFolderId: string,
  batchColor: string
): Promise<void> {
  const { resi, variant } = parsed;

  // ─── LAYER 1: Check if PDF already exists in Drive ─────────────────
  try {
    const alreadyExists = await driveService.checkOutputExists(dateFolderId, resi, variant);
    if (alreadyExists) {
      logger.debug('ORCH', `SKIP [L1] ${resi}: PDF already exists in Drive`);
      return;
    }
  } catch (err: any) {
    logger.error('ORCH', `Drive check failed for ${resi}: ${err.message}`);
    return;
  }

  // ─── LAYER 2: In-memory lock ───────────────────────────────────────
  if (!state.acquireLock(resi)) {
    logger.debug('ORCH', `SKIP [L2] ${resi}: Currently being processed`);
    return;
  }

  const job = state.createJob(resi, variant, dateFolderName, dateFolderId, orderFolderId);

  try {
    // ─── LAYER 3+4+5: Spreadsheet validation ────────────────────────
    state.updateJob(job.id, { status: 'validating', message: 'Validating with spreadsheet...', progress: 10 });

    const validation = await sheetsService.validateOrder(
      config.spreadsheetId,
      config.sheetName,
      resi,
      variant
    );

    if (!validation.valid) {
      state.completeJob(job.id, 'skipped', validation.reason || 'Validation failed');
      logger.warn('ORCH', `SKIP ${resi}: ${validation.reason}`);
      return;
    }

    const qty = validation.order?.qty || 1;
    const sheetRowNumber = validation.order!.rowNumber;

    // ─── LAYER 6: Image count validation ────────────────────────────
    state.updateJob(job.id, { status: 'validating', message: 'Checking image count...', progress: 20 });

    const imageCount = await driveService.countImagesInFolder(orderFolderId);
    if (imageCount !== variant) {
      state.completeJob(job.id, 'skipped', `Image count mismatch: has ${imageCount}, expected ${variant}`);
      logger.warn('ORCH', `SKIP [L6] ${resi}: has ${imageCount} images, expected ${variant}`);
      return;
    }

    // ─── DRY RUN: Stop before any mutations ────────────────────────
    if (config.dryRun) {
      state.completeJob(job.id, 'done', 'DRY RUN: Would process this order');
      logger.info('ORCH', `DRY RUN: ${resi} passed all validations (qty=${qty})`);
      return;
    }

    // ─── DOWNLOAD IMAGES ───────────────────────────────────────────
    state.updateJob(job.id, { status: 'downloading', message: 'Downloading images...', progress: 30 });

    const tempDir = path.join(config.tempDir, resi);
    const imagePaths = await driveService.downloadImages(orderFolderId, tempDir);

    if (imagePaths.length === 0) {
      state.completeJob(job.id, 'error', 'Failed to download any images');
      logger.error('ORCH', `ERROR ${resi}: No images downloaded`);
      return;
    }

    logger.info('ORCH', `Downloaded ${imagePaths.length} images for ${resi}`);

    // ─── GENERATE PDF ──────────────────────────────────────────────
    state.updateJob(job.id, { status: 'generating', message: 'Generating collage PDF...', progress: 50 });

    const outputFileName = buildOutputFileName(resi, variant);
    const outputPath = path.join(tempDir, outputFileName);

    await generatePDF({
      imagePaths,
      label: resi,
      qty,
      tagColor: batchColor,
      outputPath,
      onProgress: (status) => {
        state.updateJob(job.id, { message: status });
      },
    });

    // ─── UPLOAD PDF ────────────────────────────────────────────────
    state.updateJob(job.id, { status: 'uploading', message: 'Uploading PDF to Drive...', progress: 80 });

    await driveService.uploadPDF(dateFolderId, outputPath, outputFileName);

    // ─── UPLOAD TO SECONDARY DRIVE ─────────────────────────────────
    if (config.secondaryDriveFolderId) {
      state.updateJob(job.id, { status: 'uploading', message: 'Uploading PDF to Secondary Drive...', progress: 85 });
      try {
        await driveService.uploadPDF(config.secondaryDriveFolderId, outputPath, outputFileName);
        logger.info('ORCH', `Uploaded copy to Secondary Drive for ${resi}`);
      } catch (err: any) {
        logger.warn('ORCH', `Failed to upload to Secondary Drive for ${resi}: ${err.message}`);
        // Do not fail the whole job if secondary upload fails
      }
    }

    // ─── MARK DONE in Column K ─────────────────────────────────────
    state.updateJob(job.id, { status: 'marking', message: 'Marking "done" in Col K...', progress: 90 });

    await sheetsService.markAsDone(config.spreadsheetId, config.sheetName, sheetRowNumber);

    // ─── CLEANUP TEMP FILES ────────────────────────────────────────
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* non-critical */ }

    state.completeJob(job.id, 'done', `Completed: ${outputFileName} (${qty} pages)`);
    logger.success('ORCH', `✅ ${resi}: ${outputFileName} uploaded & marked "done" in Col K`);

  } catch (err: any) {
    state.completeJob(job.id, 'error', err.message);
    logger.error('ORCH', `ERROR ${resi}: ${err.message}`);
  } finally {
    state.releaseLock(resi);
  }
}
