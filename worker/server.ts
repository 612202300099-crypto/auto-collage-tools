/**
 * server.ts - Express API server for the Worker Dashboard.
 *
 * Endpoints:
 *   GET  /                        -> Dashboard HTML
 *   GET  /api/state               -> Worker state (status, jobs, history)
 *   GET  /api/logs                -> Recent system logs
 *   POST /api/start               -> Start worker
 *   POST /api/stop                -> Stop worker
 *   POST /api/force-scan          -> Trigger immediate scan
 *   POST /api/config              -> Update runtime config (interval, batch, dates, dll)
 *   GET  /api/config              -> Get current config
 *   POST /api/reset-stats         -> Reset counters + clear logs
 *   GET  /api/health              -> Health check
 *
 *   GET  /api/db/processed        -> List processed orders dari DB (paginasi)
 *   GET  /api/db/stats            -> Statistik DB (total count)
 *   DELETE /api/db/processed/:id  -> Hapus satu record (enable re-processing)
 *   DELETE /api/db/processed      -> Hapus semua records (factory reset DB)
 */
import express from 'express';
import path from 'path';
import { logger } from './utils/logger.ts';
import * as orchestrator from './core/orchestrator.ts';
import * as stateManager from './core/stateManager.ts';
import * as dbService from './services/dbService.ts';
import { saveConfig } from './config.ts';
import type { WorkerConfig } from './types.ts';

export function createServer(config: WorkerConfig) {
  const app = express();
  app.use(express.json());

  // ─── Dashboard (static HTML) ───────────────────────────────────────────────
  app.get('/', (_req, res) => {
    res.sendFile(path.resolve(import.meta.dirname, 'dashboard', 'index.html'));
  });

  // ─── API: Worker State ─────────────────────────────────────────────────────
  app.get('/api/state', (_req, res) => {
    res.json(stateManager.getState());
  });

  // ─── API: System Logs ─────────────────────────────────────────────────────
  app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit as string || '100', 10);
    res.json(logger.getRecentLogs(limit));
  });

  // ─── API: Start Worker ────────────────────────────────────────────────────
  app.post('/api/start', (_req, res) => {
    if (orchestrator.isWorkerRunning()) {
      return res.status(400).json({ error: 'Worker sudah berjalan' });
    }
    orchestrator.start(config);
    res.json({ success: true, message: 'Worker started' });
  });

  // ─── API: Stop Worker ─────────────────────────────────────────────────────
  app.post('/api/stop', (_req, res) => {
    if (!orchestrator.isWorkerRunning()) {
      return res.status(400).json({ error: 'Worker tidak sedang berjalan' });
    }
    orchestrator.stop();
    res.json({ success: true, message: 'Worker stopped' });
  });

  // ─── API: Force Immediate Scan ────────────────────────────────────────────
  app.post('/api/force-scan', (_req, res) => {
    if (!orchestrator.isWorkerRunning()) {
      return res.status(400).json({ error: 'Worker tidak berjalan. Start terlebih dahulu.' });
    }
    orchestrator.forceScan();
    res.json({ success: true, message: 'Force scan triggered' });
  });

  // ─── API: Update Configuration ────────────────────────────────────────────
  app.post('/api/config', (req, res) => {
    const {
      maxConcurrency,
      pollIntervalMinutes,
      secondaryDriveFolderId,
      batchText,
      staleTimeoutMinutes,
      dateFrom,
      dateTo,
    } = req.body;

    const envUpdates: Record<string, string> = {};

    if (maxConcurrency !== undefined) {
      const n = parseInt(maxConcurrency, 10);
      if (n >= 1 && n <= 20) {
        config.maxConcurrency = n;
        orchestrator.updateConcurrency(n);
        envUpdates['MAX_CONCURRENCY'] = n.toString();
        logger.info('API', `Max concurrency updated to ${n}`);
      }
    }

    if (pollIntervalMinutes !== undefined) {
      const n = parseInt(pollIntervalMinutes, 10);
      if (n >= 1 && n <= 60) {
        config.pollIntervalMinutes = n;
        envUpdates['POLL_INTERVAL_MINUTES'] = n.toString();
        logger.info('API', `Poll interval updated to ${n} minutes (takes effect next cycle)`);
      }
    }

    if (secondaryDriveFolderId !== undefined) {
      let folderId = secondaryDriveFolderId.trim();
      const match = folderId.match(/folders\/([a-zA-Z0-9_-]+)/);
      if (match) folderId = match[1];
      config.secondaryDriveFolderId = folderId || undefined;
      envUpdates['SECONDARY_DRIVE_FOLDER_ID'] = folderId || '';
      logger.info('API', `Secondary Drive updated to: ${folderId || '(none)'}`);
    }

    if (batchText !== undefined) {
      config.batchText = batchText.trim();
      envUpdates['BATCH_TEXT'] = config.batchText;
      logger.info('API', `Batch Text updated to "${config.batchText}"`);
    }

    if (staleTimeoutMinutes !== undefined) {
      const n = parseInt(staleTimeoutMinutes, 10);
      if (n >= 10 && n <= 1440) {
        config.staleTimeoutMinutes = n;
        envUpdates['STALE_TIMEOUT_MINUTES'] = n.toString();
        logger.info('API', `Stale timeout updated to ${n} minutes`);
      }
    }

    // ── Filter Tanggal — disimpan ke DB agar persisten setelah restart ──────
    if (dateFrom !== undefined) {
      const val = (dateFrom || '').trim();

      // Validasi format YYYY-MM-DD jika tidak kosong
      if (val && !/^\d{4}-\d{2}-\d{2}$/.test(val)) {
        return res.status(400).json({ error: 'Format dateFrom tidak valid. Gunakan YYYY-MM-DD.' });
      }

      config.dateFrom = val || undefined;
      dbService.setDbConfig('date_from', val);
      logger.info('API', `Date filter FROM: ${val || '(cleared)'}`);
    }

    if (dateTo !== undefined) {
      const val = (dateTo || '').trim();

      if (val && !/^\d{4}-\d{2}-\d{2}$/.test(val)) {
        return res.status(400).json({ error: 'Format dateTo tidak valid. Gunakan YYYY-MM-DD.' });
      }

      // Validasi: dateFrom tidak boleh lebih besar dari dateTo
      const from = config.dateFrom || (dateFrom !== undefined ? (dateFrom || '').trim() : '');
      if (from && val && val < from) {
        return res.status(400).json({ error: 'dateTo tidak boleh lebih awal dari dateFrom.' });
      }

      config.dateTo = val || undefined;
      dbService.setDbConfig('date_to', val);
      logger.info('API', `Date filter TO: ${val || '(cleared)'}`);
    }

    // Simpan perubahan .env (selain date range yang disimpan ke DB)
    if (Object.keys(envUpdates).length > 0) {
      try {
        saveConfig(envUpdates);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('API', `Gagal menyimpan config ke .env: ${msg}`);
      }
    }

    res.json({
      success: true,
      config: {
        maxConcurrency: config.maxConcurrency,
        pollIntervalMinutes: config.pollIntervalMinutes,
        secondaryDriveFolderId: config.secondaryDriveFolderId,
        batchText: config.batchText,
        staleTimeoutMinutes: config.staleTimeoutMinutes,
        dateFrom: config.dateFrom || '',
        dateTo:   config.dateTo   || '',
      },
    });
  });

  // ─── API: Get Current Config ──────────────────────────────────────────────
  app.get('/api/config', (_req, res) => {
    res.json({
      pollIntervalMinutes:    config.pollIntervalMinutes,
      maxConcurrency:         config.maxConcurrency,
      dryRun:                 config.dryRun,
      enableFaceDetection:    config.enableFaceDetection,
      driveRootFolderId:      config.driveRootFolderId,
      secondaryDriveFolderId: config.secondaryDriveFolderId,
      batchText:              config.batchText,
      staleTimeoutMinutes:    config.staleTimeoutMinutes,
      dateFrom:               config.dateFrom || '',
      dateTo:                 config.dateTo   || '',
      shops: config.shops.map(s => ({ name: s.name, spreadsheetId: s.spreadsheetId })),
    });
  });

  // ─── API: Reset Stats ─────────────────────────────────────────────────────
  app.post('/api/reset-stats', (_req, res) => {
    stateManager.resetStats();
    logger.clear();
    res.json({ success: true, message: 'Stats dan logs berhasil direset' });
  });

  // ─── API: Health Check ────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DB Endpoints — Persistent Order Tracking
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── API: List Processed Orders ───────────────────────────────────────────
  // GET /api/db/processed?limit=50&offset=0
  app.get('/api/db/processed', (req, res) => {
    const limit  = Math.min(parseInt(req.query.limit  as string || '100', 10), 500);
    const offset = Math.max(parseInt(req.query.offset as string || '0',   10), 0);

    const records = dbService.getProcessedOrders(limit, offset);
    const total   = dbService.getProcessedCount();

    res.json({
      records,
      total,
      limit,
      offset,
      hasMore: (offset + limit) < total,
    });
  });

  // ─── API: DB Statistics ───────────────────────────────────────────────────
  // GET /api/db/stats
  app.get('/api/db/stats', (_req, res) => {
    const total = dbService.getProcessedCount();
    res.json({ total });
  });

  // ─── API: Remove One Processed Order (enable re-processing) ───────────────
  // DELETE /api/db/processed/:id
  app.delete('/api/db/processed/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'ID tidak valid' });
    }

    const removed = dbService.removeProcessedOrder(id);
    if (!removed) {
      return res.status(404).json({ error: `Record ID ${id} tidak ditemukan di DB` });
    }

    logger.info('API', `DB: Removed record ID ${id} — order dapat diproses ulang`);
    res.json({ success: true, message: `Record ID ${id} berhasil dihapus. Order siap diproses ulang.` });
  });

  // ─── API: Clear All Processed Orders (factory reset) ─────────────────────
  // DELETE /api/db/processed
  app.delete('/api/db/processed', (_req, res) => {
    const count = dbService.clearAllProcessed();
    logger.warn('API', `DB: Semua ${count} record dihapus — factory reset DB`);
    res.json({
      success: true,
      message: `${count} record berhasil dihapus. Semua order dapat diproses ulang.`,
      deletedCount: count,
    });
  });

  return app;
}