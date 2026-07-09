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
import { parseFolderName, buildOutputFileName, extractResi } from '../utils/folderParser.ts';
import { parseYYYYMMDD } from '../utils/dateUtils.ts';
import { generateRandomBatchColor } from './colorUtils.ts';
import * as driveService from '../services/driveService.ts';
import * as sheetsService from '../services/sheetsService.ts';
import * as dbService from '../services/dbService.ts';
import { generatePDF } from '../engine/pdfEngine.ts';
import { WorkerPool } from './workerPool.ts';
import * as state from './stateManager.ts';
import type { WorkerConfig, ResolvedShop, ShopConfig, ParsedOrder } from '../types.ts';
import type { DateRange } from '../services/sheetsService.ts';

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

    // 2. List order subfolders inside POLAROID and LAINNYA folders
    const polaroidFolders = await driveService.listSubfolders(resolvedShop.polaroidFolderId);
    const lainnyaFolders = resolvedShop.lainnyaFolderId 
      ? await driveService.listSubfolders(resolvedShop.lainnyaFolderId) 
      : [];
    
    const totalFound = polaroidFolders.length + lainnyaFolders.length;
    logger.info('ORCH', `[${shopName}] Found ${polaroidFolders.length} folders in ${shopConfig.polaroidFolderName}` + 
      (resolvedShop.lainnyaFolderId ? ` and ${lainnyaFolders.length} in ${shopConfig.lainnyaFolderName || 'LAINNYA'}` : '')
    );

    if (totalFound === 0) return;

    // 3. Group folders by Resi AND Variant
    const orderMap = new Map<string, { resi: string; variant?: number; folderIds: string[]; rawNames: string[] }>();
    const allFolders = [...polaroidFolders, ...lainnyaFolders];

    for (const folder of allFolders) {
      const resi = extractResi(folder.name);
      if (!resi) {
        logger.debug('ORCH', `[${shopName}] Skipping non-order folder: "${folder.name}"`);
        continue;
      }

      let orderKey = resi;
      let variant: number | undefined;
      const parsed = parseFolderName(folder.name);
      if (parsed && parsed.variant) {
        variant = parsed.variant;
        orderKey = `${resi}_${variant}`;
      }

      if (orderMap.has(orderKey)) {
        orderMap.get(orderKey)!.folderIds.push(folder.id);
        orderMap.get(orderKey)!.rawNames.push(folder.name);
      } else {
        orderMap.set(orderKey, { resi, variant, folderIds: [folder.id], rawNames: [folder.name] });
      }
    }

    const tasks: Array<{ resi: string; variant?: number; lockKey: string; folderIds: string[]; rawNames: string[] }> = [];

    for (const [orderKey, data] of orderMap.entries()) {
      // ── Layer 4: In-memory lock — cegah duplikasi dalam session yang sama ─────
      const lockKey = `${shopName}:${orderKey}`;
      if (processingLocks.has(lockKey)) {
        logger.debug('ORCH', `[${shopName}] Already processing/queued: ${orderKey}`);
        continue;
      }

      // ── Layer 3: Persistent DB check — cegah re-proses setelah restart ──────
      // Gunakan variant dari folder jika ada (misal: "JX12345_25 Pcs" → 25)
      // Jika tidak ada (folder tanpa variant), skip cek ini — variant baru diketahui
      // setelah validasi sheets, dan cek DB dilakukan lagi di dalam processOrder.
      if (data.variant !== undefined) {
        const alreadyInDb = dbService.isOrderProcessed(shopName, data.resi, data.variant);
        if (alreadyInDb) {
          logger.debug('ORCH', `[${shopName}] SKIP ${orderKey}: Sudah ada di DB lokal (diproses di sesi sebelumnya)`);
          continue;
        }
      }

      // Acquire lock dan masukkan ke antrian
      processingLocks.add(lockKey);
      tasks.push({ lockKey, ...data });
    }

    if (tasks.length === 0) {
      logger.info('ORCH', `[${shopName}] No new orders to process`);
      return;
    }

    logger.info('ORCH', `[${shopName}] ${tasks.length} unique order(s) to evaluate`);

    // 4. Execute all orders with concurrency pool
    await pool!.executeAll(
      tasks.map(({ resi, variant, lockKey, folderIds, rawNames }) => async () => {
        try {
          await processOrder(resolvedShop, resi, folderIds, rawNames, config, variant);
        } finally {
          // Release lock only after execution completes (success or failure)
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

    // Find the LAINNYA subfolder inside the shop folder (optional fallback)
    let lainnyaFolderId: string | undefined;
    if (shopConfig.lainnyaFolderName) {
      const lainnyaFolder = await driveService.findFolderByName(shopFolder.id, shopConfig.lainnyaFolderName);
      if (lainnyaFolder) {
        lainnyaFolderId = lainnyaFolder.id;
      }
    }

    // Auto-detect dynamic columns (or use override from config)
    const columns = shopConfig.columns ||
      await sheetsService.detectShopColumns(shopConfig.spreadsheetId, shopConfig.sheetName);

    return {
      ...shopConfig,
      shopFolderId: shopFolder.id,
      polaroidFolderId: polaroidFolder.id,
      lainnyaFolderId,
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
  resi: string,
  folderIds: string[],
  rawNames: string[],
  config: WorkerConfig,
  folderVariant?: number,
): Promise<void> {
  const shopName = shop.name;
  const orderKey = folderVariant ? `${resi}_${folderVariant}` : resi;
  const jobId = `${shopName}:${orderKey}:${Date.now()}`;

  // Create job tracking entry (variant is unknown at first)
  const job = state.addJob({
    id: jobId,
    resi,
    variant: 0,
    qty: 1,
    shopName,
    orderFolderId: rawNames.join(' + '),
    status: 'validating',
    message: 'Validating against spreadsheet...',
    startedAt: Date.now(),
    progress: 0,
  });

  try {
    // Step 1: Validasi ke Spreadsheet
    state.updateJob(jobId, { status: 'validating', message: 'Memeriksa spreadsheet...', progress: 10 });

    // Bangun DateRange dari config (undefined jika filter tanggal tidak aktif)
    const dateRange: DateRange | undefined =
      (config.dateFrom || config.dateTo)
        ? {
            from: config.dateFrom ? parseYYYYMMDD(config.dateFrom) ?? undefined : undefined,
            to:   config.dateTo   ? parseYYYYMMDD(config.dateTo)   ?? undefined : undefined,
          }
        : undefined;

    const validation = await sheetsService.validateOrderByResi(
      shop.spreadsheetId, shop.sheetName, resi, shop.columns, folderVariant, dateRange,
    );

    if (!validation.valid) {
      logger.info('ORCH', `[${shopName}] SKIP ${resi}: ${validation.reason}`);
      state.updateJob(jobId, { status: 'skipped', message: validation.reason || 'Validation failed', progress: 100 });
      state.completeJob(jobId, 'skipped');
      return;
    }

    const order = validation.order!;
    const requiredPhotos = order.variant; // Foto unik yang dibutuhkan (misal: 25)
    const qty = order.qty;               // Jumlah copy cetak (misal: 2x print)

    state.updateJob(jobId, { variant: requiredPhotos, qty, message: `Tervalidasi: ${requiredPhotos} foto × ${qty} copy` });
    logger.info('ORCH', `[${shopName}] ${resi}: Tervalidasi dari sheet — butuh ${requiredPhotos} foto, ${qty} copy`);

    // ── Step 2: Cek DB Lokal (Layer 3 Anti-Duplikasi) ───────────────────────
    // Di sini kita sudah tahu variant dari sheets, sehingga cek DB-nya akurat.
    // Ini menangani kasus folder tanpa variant di namanya.
    const alreadyInDb = dbService.isOrderProcessed(shopName, resi, order.variant);
    if (alreadyInDb) {
      logger.info('ORCH', `[${shopName}] SKIP ${resi} (${order.variant} pcs): Sudah ada di DB lokal`);
      state.updateJob(jobId, { status: 'skipped', message: 'Sudah diproses di sesi sebelumnya (DB lokal)', progress: 100 });
      state.completeJob(jobId, 'skipped');
      return;
    }

    // ── Step 2: Check if output PDF already exists in secondary Drive ──
    if (config.secondaryDriveFolderId) {
      const outputExists = await driveService.checkResiOutputExists(
        config.secondaryDriveFolderId, resi,
      );
      if (outputExists) {
        state.updateJob(jobId, { status: 'skipped', message: 'PDF already exists in secondary Drive', progress: 100 });
        state.completeJob(jobId, 'skipped');
        return;
      }
    }

    // ── Step 3: Write "PROSES" to Spreadsheet ──────────────────────────
    if (!config.dryRun) {
      try {
        await sheetsService.updateOrderStatus(
          shop.spreadsheetId, shop.sheetName, order.rowNumber, shop.columns,
          { statusText: 'PROSES' }
        );
      } catch (e: any) {
        logger.warn('ORCH', `[${shopName}] Failed to write PROSES for ${resi}: ${e.message}`);
      }
    }

    // ── Step 3: Inspect merged folders (count + deduplicate + stale) ───
    state.updateJob(jobId, { status: 'downloading', message: 'Inspecting folders...', progress: 20 });

    const inspection = await driveService.inspectMultipleFolders(folderIds);

    // 4a: No images at all → skip
    if (inspection.count === 0) {
      logger.info('ORCH', `[${shopName}] SKIP ${resi}: No images in folder(s)`);
      if (!config.dryRun) {
        await sheetsService.updateOrderStatus(
          shop.spreadsheetId, shop.sheetName, order.rowNumber, shop.columns,
          { statusText: 'BELUM KIRIM FOTO' }
        ).catch(() => {});
      }
      state.updateJob(jobId, { status: 'skipped', message: 'No images found in folder(s)', progress: 100 });
      state.completeJob(jobId, 'skipped');
      return;
    }

    // 4b: Check if enough photos OR stale (last upload was long ago)
    let photosToUse = requiredPhotos;

    if (inspection.count < requiredPhotos) {
      const minutesAgo = inspection.minutesSinceLastUpload;
      const staleThreshold = config.staleTimeoutMinutes;

      if (minutesAgo !== null && minutesAgo >= staleThreshold) {
        // STALE: foto kurang tapi sudah lama tidak ada upload baru → proses dengan yang ada, TAPI GANDAKAN FOTO HINGGA LENGKAP!
        logger.info('ORCH', `[${shopName}] ${resi}: Incomplete (${inspection.count}/${requiredPhotos}) but STALE — last upload ${minutesAgo} min ago (threshold: ${staleThreshold} min). Duplicating ${inspection.count} photos to reach ${requiredPhotos}.`);
        // We do NOT change photosToUse here, keep it at requiredPhotos so we can duplicate later.
      } else {
        // FRESH: masih mungkin uploading → skip, tunggu cycle berikutnya
        const timeInfo = minutesAgo !== null ? `last upload ${minutesAgo} min ago` : 'unknown upload time';
        logger.info('ORCH', `[${shopName}] SKIP ${resi}: Incomplete (${inspection.count}/${requiredPhotos}), ${timeInfo} — waiting for more photos`);
        if (!config.dryRun) {
          await sheetsService.updateOrderStatus(
            shop.spreadsheetId, shop.sheetName, order.rowNumber, shop.columns,
            { statusText: 'FOTO BELUM LENGKAP' }
          ).catch(() => {});
        }
        state.updateJob(jobId, { status: 'skipped', message: `Waiting: ${inspection.count}/${requiredPhotos} photos, ${timeInfo}`, progress: 100 });
        state.completeJob(jobId, 'skipped');
        return;
      }
    }

    // ── Step 4: Download images ───────────────────────────────────────
    state.updateJob(jobId, { status: 'downloading', message: `Downloading ${photosToUse} images (newest first)...`, progress: 30 });

    const tempDir = path.join(config.tempDir, `${shopName}_${resi}_${Date.now()}`);
    let localPaths: string[];

    try {
      localPaths = await driveService.downloadImages(inspection.uniqueFiles, tempDir, {
        limit: photosToUse,
        sortByNewest: true,
      });

      // ── Step 4c: Duplicate if not enough ──────────────────────────────
      if (localPaths.length > 0 && localPaths.length < requiredPhotos) {
        const initialCount = localPaths.length;
        logger.info('ORCH', `[${shopName}] ${resi}: Only ${initialCount} photos downloaded. Duplicating to reach exactly ${requiredPhotos}...`);
        
        let sourceIndex = 0;
        while (localPaths.length < requiredPhotos) {
          // Re-use the paths sequentially
          localPaths.push(localPaths[sourceIndex % initialCount]);
          sourceIndex++;
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Download failed: ${msg}`);
    }

    logger.info('ORCH', `[${shopName}] ${resi}: Using ${localPaths.length} photos × ${qty} copies`);

    // ── Step 5: Generate PDF ──────────────────────────────────────────
    state.updateJob(jobId, { status: 'generating', message: `Generating PDF (${localPaths.length} photos)...`, progress: 40 });

    const batchColor = generateRandomBatchColor();
    const outputFileName = buildOutputFileName(resi, requiredPhotos);
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

    // ── Step 6: Upload PDF to secondary Drive ─────────────────────────
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

    // ── Step 7: Mark as processed in spreadsheet ──────────────────────
    // Step 7: Tandai selesai di spreadsheet
    if (!config.dryRun) {
      state.updateJob(jobId, { status: 'marking', message: 'Menulis SELESAI ke spreadsheet...', progress: 90 });

      try {
        await sheetsService.updateOrderStatus(
          shop.spreadsheetId,
          shop.sheetName,
          order.rowNumber,
          shop.columns,
          {
            statusText: 'SELESAI',
            botDone: true,
            batchText: config.batchText,
          }
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Gagal menulis status ke spreadsheet: `+msg);
      }

      // Step 8: Simpan ke DB Lokal (anti-duplikasi persisten)
      // Dilakukan SETELAH sheets berhasil — jika sheets throw, DB tidak tertulis
      // sehingga order bisa retry di sesi berikutnya.
      try {
        dbService.markOrderProcessed(
          shopName,
          resi,
          order.variant,
          config.batchText,
          order.rowNumber,
        );
      } catch (dbErr: unknown) {
        // DB write failure bukan fatal — sheets sudah terupdate, cukup log
        const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
        logger.warn('ORCH', `[`+shopName+`] Gagal menulis ke DB lokal (non-fatal): `+msg);
      }
    } else {
      logger.info('ORCH', `[`+shopName+`] DRY RUN: Would mark row `+order.rowNumber+` as SELESAI & DONE`);
    }

    // ── Done! ─────────────────────────────────────────────────────────
    state.updateJob(jobId, { status: 'done', message: `✅ Completed successfully`, progress: 100 });
    state.completeJob(jobId, 'done');
    logger.success('ORCH', `[${shopName}] ✅ ${resi} — ${requiredPhotos} pcs × ${order.qty} — DONE`);

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
