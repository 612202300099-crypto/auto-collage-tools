/**
 * index.ts - Entry point for the AutoCollage Worker.
 *
 * Boot sequence:
 *   1. Load config (env variables)
 *   2. Init SQLite DB (persistent order tracking + config)
 *   3. Load persisted date range filter dari DB ke config
 *   4. Init Google Auth
 *   5. Start Express server (dashboard + API)
 *   6. Auto-start worker jika flag --auto
 *
 * Usage:
 *   tsx worker/index.ts           -> Start server only (control via dashboard)
 *   tsx worker/index.ts --auto    -> Start server + auto-start worker
 *   tsx worker/index.ts --dry-run -> Dry run mode (tidak ada upload/write ke sheets)
 */
import { loadConfig } from './config.ts';
import { initGoogleAuth } from './services/googleAuth.ts';
import * as dbService from './services/dbService.ts';
import { createServer } from './server.ts';
import { logger } from './utils/logger.ts';
import * as orchestrator from './core/orchestrator.ts';

async function main() {
  console.log('\n');
  console.log('  +===================================================+');
  console.log('  |    AutoCollage Worker v2.1 - Multi-Shop           |');
  console.log('  |    Polaroid Collage Pipeline Engine               |');
  console.log('  +===================================================+');
  console.log('');

  const args = process.argv.slice(2);
  const autoStart = args.includes('--auto');
  const dryRun    = args.includes('--dry-run');

  try {
    // Step 1: Load configuration
    const config = loadConfig();
    if (dryRun) config.dryRun = true;

    logger.info('BOOT', `Config loaded - Root: ${config.driveRootFolderId.substring(0, 10)}... | ${config.shops.length} shop(s)`);
    for (const shop of config.shops) {
      logger.info('BOOT', `  -> ${shop.name} (Sheet: ${shop.spreadsheetId.substring(0, 10)}...)`);
    }
    logger.info('BOOT', `Polling: ${config.pollIntervalMinutes} min | Concurrency: ${config.maxConcurrency} | DryRun: ${config.dryRun}`);
    if (config.batchText) {
      logger.info('BOOT', `Batch Text: "${config.batchText}"`);
    }

    // Step 2: Initialize SQLite Database
    // Harus SEBELUM server start agar endpoint /api/db/* langsung siap.
    dbService.initDb(config.dbPath);

    // Step 3: Load persisted date range dari DB ke config
    // Memastikan filter tanggal yang diatur operator tetap aktif setelah restart.
    const storedDateFrom = dbService.getDbConfig('date_from');
    const storedDateTo   = dbService.getDbConfig('date_to');
    if (storedDateFrom) {
      config.dateFrom = storedDateFrom;
      logger.info('BOOT', `Filter tanggal dari DB - Dari: ${storedDateFrom}`);
    }
    if (storedDateTo) {
      config.dateTo = storedDateTo;
      logger.info('BOOT', `Filter tanggal dari DB - Sampai: ${storedDateTo}`);
    }
    if (!storedDateFrom && !storedDateTo) {
      logger.info('BOOT', 'Filter tanggal: tidak aktif (semua tanggal diproses)');
    }

    const dbCount = dbService.getProcessedCount();
    logger.info('BOOT', `DB: ${dbCount} order tersimpan di database lokal (${config.dbPath})`);

    // Step 4: Initialize Google APIs
    await initGoogleAuth(config.googleCredentialsPath, config.googleTokenPath);

    // Step 5: Start Express server
    const app = createServer(config);

    app.listen(config.serverPort, () => {
      logger.success('BOOT', `Dashboard running at http://localhost:${config.serverPort}`);
      logger.info('BOOT', `API ready at http://localhost:${config.serverPort}/api/*`);

      if (autoStart) {
        logger.info('BOOT', 'Auto-start flag detected - starting worker...');
        orchestrator.start(config);
      } else {
        logger.info('BOOT', 'Worker STOPPED. Buka dashboard atau POST /api/start untuk mulai.');
      }
    });

    // Step 6: Graceful shutdown - tutup DB agar WAL ter-flush ke disk
    const shutdown = (signal: string) => {
      logger.warn('BOOT', `Received ${signal} - shutting down gracefully...`);
      orchestrator.stop();
      dbService.closeDb();
      process.exit(0);
    };

    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    process.on('uncaughtException', (err) => {
      logger.error('BOOT', `Uncaught Exception: ${err.message}`);
      logger.error('BOOT', err.stack || '');
    });

    process.on('unhandledRejection', (reason) => {
      logger.error('BOOT', `Unhandled Rejection: ${reason}`);
    });

  } catch (err: any) {
    console.error('FATAL:', err.message);
    process.exit(1);
  }
}

main();