/**
 * index.ts — Entry point for the AutoCollage Worker.
 *
 * Initializes Google Auth, loads config, starts Express server,
 * and optionally auto-starts the worker.
 *
 * Usage:
 *   tsx worker/index.ts            → Start server (worker stopped, control via dashboard)
 *   tsx worker/index.ts --auto     → Start server AND auto-start worker
 *   tsx worker/index.ts --dry-run  → Dry run mode (no upload/write)
 */
import { loadConfig } from './config.ts';
import { initGoogleAuth } from './services/googleAuth.ts';
import { createServer } from './server.ts';
import { logger } from './utils/logger.ts';
import * as orchestrator from './core/orchestrator.ts';

async function main() {
  console.log('\n');
  console.log('  ╔═══════════════════════════════════════════════════╗');
  console.log('  ║    🖨️  AutoCollage Worker v2.0 — Multi-Shop       ║');
  console.log('  ║       Polaroid Collage Pipeline Engine            ║');
  console.log('  ╚═══════════════════════════════════════════════════╝');
  console.log('');

  // Parse CLI flags
  const args = process.argv.slice(2);
  const autoStart = args.includes('--auto');
  const dryRun = args.includes('--dry-run');

  try {
    // 1. Load configuration
    const config = loadConfig();
    if (dryRun) config.dryRun = true;

    logger.info('BOOT', `Config loaded — Root: ${config.driveRootFolderId.substring(0, 10)}... | ${config.shops.length} shop(s)`);
    for (const shop of config.shops) {
      logger.info('BOOT', `  → ${shop.name} (Sheet: ${shop.spreadsheetId.substring(0, 10)}...)`);
    }
    logger.info('BOOT', `Polling: ${config.pollIntervalMinutes} min | Concurrency: ${config.maxConcurrency} | DryRun: ${config.dryRun}`);
    if (config.editorText) {
      logger.info('BOOT', `Editor Text: "${config.editorText}"`);
    }

    // 2. Initialize Google APIs
    await initGoogleAuth(config.googleCredentialsPath, config.googleTokenPath);

    // 3. Start Express server
    const app = createServer(config);

    app.listen(config.serverPort, () => {
      logger.success('BOOT', `Dashboard running at http://localhost:${config.serverPort}`);
      logger.info('BOOT', `API endpoints ready at http://localhost:${config.serverPort}/api/*`);

      if (autoStart) {
        logger.info('BOOT', 'Auto-start flag detected — starting worker...');
        orchestrator.start(config);
      } else {
        logger.info('BOOT', 'Worker is STOPPED. Use the dashboard or POST /api/start to begin.');
      }
    });

    // 4. Graceful shutdown
    const shutdown = (signal: string) => {
      logger.warn('BOOT', `Received ${signal} — shutting down gracefully...`);
      orchestrator.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // 5. Uncaught error handling (safety net)
    process.on('uncaughtException', (err) => {
      logger.error('BOOT', `Uncaught Exception: ${err.message}`);
      logger.error('BOOT', err.stack || '');
      // Don't exit — keep the server running
    });

    process.on('unhandledRejection', (reason) => {
      logger.error('BOOT', `Unhandled Rejection: ${reason}`);
    });

  } catch (err: any) {
    console.error('❌ FATAL:', err.message);
    process.exit(1);
  }
}

main();
