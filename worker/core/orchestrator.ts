/**
 * orchestrator.ts — Main automation loop for the Worker.
 *
 * Multi-shop architecture:
 * 1. For each configured shop, find the POLAROID folder in Drive
 * 2. Scan order subfolders (e.g., "JX9171527480_25 Pcs")
 * 3. Validate against the shop's spreadsheet
 * 4. Download → Generate PDF → Upload to secondary Drive → Mark as BOT
 *
 * No date folders — hierarchy is: Root → Shop → POLAROID → Order → Photos
 */
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.ts';
import { parseFolderName, buildOutputFileName } from '../utils/folderParser.ts';
import { generateRandomBatchColor } from './colorUtils.ts';
import * as driveService from '../services/driveService.ts';
import * as sheetsService from '../services/sheetsService.ts';
import { generatePDF } from '../engine/pdfEngine.ts';
import { WorkerPool } from './workerPool.ts';
import * as state from './stateManager.ts';
import type { WorkerConfig, ResolvedShop, ShopConfig, ParsedOrder } from '../types.ts';

let isRunning = false;
let scanTimer: ReturnType<typeof setTimeout> | null = null;
let pool: WorkerPool | null = null;
let currentConfig: WorkerConfig | null = null;

// In-memory lock to prevent duplicate processing within the same scan cycle
const processingLocks = new Set<string>();

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
  logger.success('ORCH', `Worker STARTED — ${config.shops.length} shops, Polling: ${config.pollIntervalMinutes} min, Concurrency: ${config.maxConcurrency}`);

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
  if (!currentConfig || !pool) return;

  state.setScanning();
  logger.info('ORCH', '═══════════════ SCAN CYCLE START ═══════════════');

  try {
    // Process each shop sequentially (discover folders), but orders in parallel
    for (const shopConfig of currentConfig.shops) {
      if (!isRunning) break;
      await processShop(shopConfig, currentConfig);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('ORCH', `Scan cycle error: ${message}`);
  }

  logger.info('ORCH', '═══════════════ SCAN CYCLE END ═════════════════');

  // Schedule next scan
  if (isRunning && currentConfig) {
    const intervalMs = currentConfig.pollIntervalMinutes * 60 * 1000;
    const nextScanAt = Date.now() + intervalMs;
    state.setIdle(nextScanAt);
    scanTimer = setTimeout(runScanCycle, intervalMs);
    logger.info('ORCH', `Next scan in ${currentConfig.pollIntervalMinutes} minutes`);
  }
}

// ─── SHOP PROCESSING ─────────────────────────────────────────────────────────

/**
 * Process a single shop: discover Drive folders, scan orders, process them.
 */
async function processShop(shopConfig: ShopConfig, config: WorkerConfig): Promise<void> {
  const shopName = shopConfig.name;
  logger.info('ORCH', `──── Shop: ${shopName} ────`);

  try {
    // 1. Resolve the shop — find Drive folders + auto-detect EDITOR column
    const resolvedShop = await resolveShop(shopConfig, config.driveRootFolderId);
    if (!resolvedShop) return; // Error already logged

    // 2. List order subfolders inside POLAROID folder
    const orderFolders = await driveService.listSubfolders(resolvedShop.polaroidFolderId);
    logger.info('ORCH', `[${shopName}] Found ${orderFolders.length} folders in ${shopConfig.polaroidFolderName}`);

    if (orderFolders.length === 0) return;

    // 3. Parse & filter valid order folder names
    const tasks: Array<{ parsed: ParsedOrder; folderId: string }> = [];

    for (const folder of orderFolders) {
      const parsed = parseFolderName(folder.name);
      if (!parsed) {
        logger.debug('ORCH', `[${shopName}] Skipping non-order folder: "${folder.name}"`);
        continue;
      }

      // In-memory lock check (prevent duplicate within same cycle)
      const lockKey = `${shopName}:${parsed.resi}`;
      if (processingLocks.has(lockKey)) {
        logger.debug('ORCH', `[${shopName}] Already processing: ${parsed.resi}`);
        continue;
      }

      tasks.push({ parsed, folderId: folder.id });
    }

    if (tasks.length === 0) {
      logger.info('ORCH', `[${shopName}] No new orders to process`);
      return;
    }

    logger.info('ORCH', `[${shopName}] ${tasks.length} order(s) to evaluate`);

    // 4. Execute all orders with concurrency pool
    await pool!.executeAll(
      tasks.map(({ parsed, folderId }) => async () => {
        const lockKey = `${shopName}:${parsed.resi}`;
        processingLocks.add(lockKey);
        try {
          await processOrder(resolvedShop, parsed, folderId, config);
        } finally {
          processingLocks.delete(lockKey);
        }
      }),
    );

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('ORCH', `[${shopName}] Shop processing error: ${message}`);
  }
}

/**
 * Resolve a ShopConfig into a ResolvedShop by discovering Drive folder IDs
 * and auto-detecting the EDITOR column from the spreadsheet header.
 */
async function resolveShop(
  shopConfig: ShopConfig,
  rootFolderId: string,
): Promise<ResolvedShop | null> {
  const shopName = shopConfig.name;

  try {
    // Find the shop folder inside root PESANAN folder
    const shopFolder = await driveService.findFolderByName(rootFolderId, shopName);
    if (!shopFolder) {
      // Debug: show what folders ARE in the root so user can fix shop name
      const allFolders = await driveService.listSubfolders(rootFolderId);
      const folderNames = allFolders.map(f => `"${f.name}"`).join(', ');
      logger.warn('ORCH', `[${shopName}] Shop folder not found in Drive root. Available folders: [${folderNames}]`);
      return null;
    }

    // Find the POLAROID subfolder inside the shop folder
    const polaroidFolder = await driveService.findFolderByName(shopFolder.id, shopConfig.polaroidFolderName);
    if (!polaroidFolder) {
      logger.warn('ORCH', `[${shopName}] "${shopConfig.polaroidFolderName}" folder not found inside shop folder. Skipping.`);
      return null;
    }

    // Auto-detect EDITOR column (or use override from config)
    const columns = shopConfig.columns ||
      await sheetsService.detectEditorColumn(shopConfig.spreadsheetId, shopConfig.sheetName);

    return {
      ...shopConfig,
      shopFolderId: shopFolder.id,
      polaroidFolderId: polaroidFolder.id,
      columns,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('ORCH', `[${shopName}] Failed to resolve shop: ${message}`);
    return null;
  }
}

// ─── ORDER PROCESSING ────────────────────────────────────────────────────────

/**
 * Process a single order: validate → download → generate PDF → upload → mark done.
 */
async function processOrder(
  shop: ResolvedShop,
  parsed: ParsedOrder,
  orderFolderId: string,
  config: WorkerConfig,
): Promise<void> {
  const { resi, variant } = parsed;
  const shopName = shop.name;
  const jobId = `${shopName}:${resi}:${Date.now()}`;

  // Create job tracking entry
  const job = state.addJob({
    id: jobId,
    resi,
    variant,
    qty: 1,
    shopName,
    orderFolderId,
    status: 'validating',
    message: 'Validating against spreadsheet...',
    startedAt: Date.now(),
    progress: 0,
  });

  try {
    // ── Step 1: Check if output PDF already exists in secondary Drive ──
    if (config.secondaryDriveFolderId) {
      const outputExists = await driveService.checkOutputExists(
        config.secondaryDriveFolderId, resi, variant,
      );
      if (outputExists) {
        state.updateJob(jobId, { status: 'skipped', message: 'PDF already exists in secondary Drive', progress: 100 });
        state.completeJob(jobId, 'skipped');
        return;
      }
    }

    // ── Step 2: Validate against spreadsheet ──────────────────────────
    state.updateJob(jobId, { status: 'validating', message: 'Checking spreadsheet...', progress: 10 });

    const validation = await sheetsService.validateOrder(
      shop.spreadsheetId, shop.sheetName, resi, variant, shop.columns,
    );

    if (!validation.valid) {
      logger.info('ORCH', `[${shopName}] SKIP ${resi}: ${validation.reason}`);
      state.updateJob(jobId, { status: 'skipped', message: validation.reason || 'Validation failed', progress: 100 });
      state.completeJob(jobId, 'skipped');
      return;
    }

    const order = validation.order!;
    const requiredPhotos = order.variant; // Unique photos needed (e.g., 25)
    const qty = order.qty;               // Number of copies (e.g., 2x print)

    state.updateJob(jobId, { qty, message: `Validated: ${requiredPhotos} photos × ${qty} copies` });
    logger.info('ORCH', `[${shopName}] ${resi}: Validated — need ${requiredPhotos} photos, ${qty} copies`);

    // ── Step 3: Count images first (pre-check without downloading) ────
    state.updateJob(jobId, { status: 'downloading', message: 'Counting images...', progress: 20 });

    const imageCount = await driveService.countImagesInFolder(orderFolderId);

    if (imageCount === 0) {
      logger.info('ORCH', `[${shopName}] SKIP ${resi}: No images in folder`);
      state.updateJob(jobId, { status: 'skipped', message: 'No images found in folder', progress: 100 });
      state.completeJob(jobId, 'skipped');
      return;
    }

    // ── Step 3b: Check if enough photos ───────────────────────────────
    if (imageCount < requiredPhotos) {
      logger.info('ORCH', `[${shopName}] SKIP ${resi}: Not enough photos (${imageCount}/${requiredPhotos}) — order incomplete`);
      state.updateJob(jobId, { status: 'skipped', message: `Incomplete: ${imageCount}/${requiredPhotos} photos`, progress: 100 });
      state.completeJob(jobId, 'skipped');
      return;
    }

    // ── Step 4: Download images ───────────────────────────────────────
    state.updateJob(jobId, { status: 'downloading', message: `Downloading ${requiredPhotos} images...`, progress: 30 });

    const tempDir = path.join(config.tempDir, `${shopName}_${resi}_${Date.now()}`);
    let localPaths: string[];

    try {
      localPaths = await driveService.downloadImages(orderFolderId, tempDir);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Download failed: ${msg}`);
    }

    // ── Step 4b: Trim to exactly `variant` photos (not variant×qty) ──
    // qty is for PDF page duplication (copies), NOT extra photos
    if (localPaths.length > requiredPhotos) {
      logger.info('ORCH', `[${shopName}] ${resi}: ${localPaths.length} photos found, using first ${requiredPhotos} (variant count)`);
      localPaths = localPaths.slice(0, requiredPhotos);
    }

    logger.info('ORCH', `[${shopName}] ${resi}: Using ${localPaths.length} photos × ${qty} copies`);

    // ── Step 4: Generate PDF ──────────────────────────────────────────
    state.updateJob(jobId, { status: 'generating', message: `Generating PDF (${localPaths.length} photos)...`, progress: 40 });

    const batchColor = generateRandomBatchColor();
    const outputFileName = buildOutputFileName(resi, variant);
    const outputPath = path.join(tempDir, outputFileName);

    try {
      await generatePDF({
        imagePaths: localPaths,
        outputPath,
        label: resi,
        qty: order.qty,
        tagColor: batchColor,
        onProgress: (statusMsg) => {
          state.updateJob(jobId, { progress: 60, message: `Generating PDF... ${statusMsg}` });
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`PDF generation failed: ${msg}`);
    }

    // ── Step 5: Upload PDF to secondary Drive ─────────────────────────
    if (config.secondaryDriveFolderId && !config.dryRun) {
      state.updateJob(jobId, { status: 'uploading', message: 'Uploading PDF...', progress: 75 });

      try {
        await driveService.uploadPDF(config.secondaryDriveFolderId, outputPath, outputFileName);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Upload failed: ${msg}`);
      }
    } else if (config.dryRun) {
      logger.info('ORCH', `[${shopName}] DRY RUN: Would upload ${outputFileName}`);
    }

    // ── Step 6: Mark as processed in spreadsheet ──────────────────────
    if (!config.dryRun) {
      state.updateJob(jobId, { status: 'marking', message: 'Marking as BOT in spreadsheet...', progress: 90 });

      try {
        await sheetsService.markAsProcessed(
          shop.spreadsheetId,
          shop.sheetName,
          order.rowNumber,
          shop.columns,
          config.editorText,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Sheet marking failed: ${msg}`);
      }
    } else {
      logger.info('ORCH', `[${shopName}] DRY RUN: Would mark row ${order.rowNumber} as BOT`);
    }

    // ── Done! ─────────────────────────────────────────────────────────
    state.updateJob(jobId, { status: 'done', message: `✅ Completed successfully`, progress: 100 });
    state.completeJob(jobId, 'done');
    logger.success('ORCH', `[${shopName}] ✅ ${resi} — ${variant} pcs × ${order.qty} — DONE`);

    // Cleanup temp files
    cleanup(tempDir);

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('ORCH', `[${shopName}] ❌ ${resi}: ${message}`);
    state.updateJob(jobId, { status: 'error', message, progress: 100 });
    state.completeJob(jobId, 'error');

    // Cleanup even on error
    cleanup(path.join(config.tempDir, `${shopName}_${resi}_*`));
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * Safely remove a temporary directory and its contents.
 */
function cleanup(dirPath: string): void {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch {
    // Non-critical — temp files will be cleaned up eventually
  }
}
