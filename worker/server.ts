/**
 * server.ts — Express API server for the Worker Dashboard.
 *
 * Provides:
 * - REST API for worker control (start/stop/configure)
 * - Real-time state & log endpoints for the dashboard
 * - Serves the dashboard HTML
 * - Multi-shop configuration management
 */
import express from 'express';
import path from 'path';
import { logger } from './utils/logger.ts';
import * as orchestrator from './core/orchestrator.ts';
import * as stateManager from './core/stateManager.ts';
import { saveConfig } from './config.ts';
import type { WorkerConfig } from './types.ts';

export function createServer(config: WorkerConfig) {
  const app = express();
  app.use(express.json());

  // ─── Dashboard (static HTML) ───────────────────────────────────────────
  app.get('/', (_req, res) => {
    res.sendFile(path.resolve(import.meta.dirname, 'dashboard', 'index.html'));
  });

  // ─── API: Get worker state ─────────────────────────────────────────────
  app.get('/api/state', (_req, res) => {
    res.json(stateManager.getState());
  });

  // ─── API: Get recent logs ─────────────────────────────────────────────
  app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit as string || '100', 10);
    res.json(logger.getRecentLogs(limit));
  });

  // ─── API: Start worker ────────────────────────────────────────────────
  app.post('/api/start', (_req, res) => {
    if (orchestrator.isWorkerRunning()) {
      return res.status(400).json({ error: 'Worker is already running' });
    }
    orchestrator.start(config);
    res.json({ success: true, message: 'Worker started' });
  });

  // ─── API: Stop worker ─────────────────────────────────────────────────
  app.post('/api/stop', (_req, res) => {
    if (!orchestrator.isWorkerRunning()) {
      return res.status(400).json({ error: 'Worker is not running' });
    }
    orchestrator.stop();
    res.json({ success: true, message: 'Worker stopped' });
  });

  // ─── API: Force immediate scan ────────────────────────────────────────
  app.post('/api/force-scan', (_req, res) => {
    if (!orchestrator.isWorkerRunning()) {
      return res.status(400).json({ error: 'Worker is not running. Start it first.' });
    }
    orchestrator.forceScan();
    res.json({ success: true, message: 'Force scan triggered' });
  });

  // ─── API: Update configuration ────────────────────────────────────────
  app.post('/api/config', (req, res) => {
    const { maxConcurrency, pollIntervalMinutes, secondaryDriveFolderId, editorText } = req.body;
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
      logger.info('API', `Secondary Drive Folder updated to ${folderId ? folderId : 'none'}`);
    }

    if (editorText !== undefined) {
      config.editorText = editorText.trim();
      envUpdates['EDITOR_TEXT'] = config.editorText;
      logger.info('API', `Editor Text updated to "${config.editorText}"`);
    }

    if (Object.keys(envUpdates).length > 0) {
      try {
        saveConfig(envUpdates);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('API', `Failed to save config to .env: ${msg}`);
      }
    }

    res.json({
      success: true,
      config: {
        maxConcurrency: config.maxConcurrency,
        pollIntervalMinutes: config.pollIntervalMinutes,
        secondaryDriveFolderId: config.secondaryDriveFolderId,
        editorText: config.editorText,
      },
    });
  });

  // ─── API: Get config ──────────────────────────────────────────────────
  app.get('/api/config', (_req, res) => {
    res.json({
      pollIntervalMinutes: config.pollIntervalMinutes,
      maxConcurrency: config.maxConcurrency,
      dryRun: config.dryRun,
      enableFaceDetection: config.enableFaceDetection,
      driveRootFolderId: config.driveRootFolderId,
      secondaryDriveFolderId: config.secondaryDriveFolderId,
      editorText: config.editorText,
      shops: config.shops.map(s => ({ name: s.name, spreadsheetId: s.spreadsheetId })),
    });
  });

  // ─── API: Reset stats ─────────────────────────────────────────────────
  app.post('/api/reset-stats', (_req, res) => {
    stateManager.resetStats();
    logger.clear();
    res.json({ success: true, message: 'Stats and logs cleared' });
  });

  // ─── API: Health check ────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
    });
  });

  return app;
}
