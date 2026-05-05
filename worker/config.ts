/**
 * config.ts — Environment-based configuration for the Worker.
 *
 * Semua konfigurasi dibaca dari environment variables (.env)
 * dengan sensible defaults. Validasi dilakukan saat startup.
 */
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import type { WorkerConfig } from './types.ts';

// Load .env dari root project (satu level di atas worker/)
dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env') });

function requireEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] || defaultValue;
  if (!value) {
    throw new Error(`[CONFIG] Missing required environment variable: ${key}`);
  }
  return value;
}

export function loadConfig(): WorkerConfig {
  const config: WorkerConfig = {
    googleCredentialsPath: requireEnv(
      'GOOGLE_CREDENTIALS_PATH',
      path.resolve(import.meta.dirname, '..', 'credentials', 'credentials.json')
    ),
    googleTokenPath: requireEnv(
      'GOOGLE_TOKEN_PATH',
      path.resolve(import.meta.dirname, '..', 'credentials', 'token.json')
    ),
    driveRootFolderId: requireEnv('DRIVE_ROOT_FOLDER_ID'),
    spreadsheetId: requireEnv('SPREADSHEET_ID'),
    sheetName: requireEnv('SHEET_NAME', 'FOTO POLAROID'),
    eksportSheetName: requireEnv('EKSPORT_SHEET_NAME', 'EKSPORT'),
    pollIntervalMinutes: parseInt(process.env.POLL_INTERVAL_MINUTES || '5', 10),
    maxConcurrency: parseInt(process.env.MAX_CONCURRENCY || '5', 10),
    tempDir: path.resolve(import.meta.dirname, '..', '.tmp-worker'),
    enableFaceDetection: process.env.ENABLE_FACE_DETECTION !== 'false',
    dryRun: process.env.DRY_RUN === 'true',
    serverPort: parseInt(process.env.WORKER_PORT || '4000', 10),
    secondaryDriveFolderId: process.env.SECONDARY_DRIVE_FOLDER_ID,
    targetDateFilter: process.env.TARGET_DATE_FILTER || 'ALL',
  };

  // Validate: Credentials file must exist
  if (!fs.existsSync(config.googleCredentialsPath)) {
    throw new Error(
      `[CONFIG] OAuth Credentials file not found: ${config.googleCredentialsPath}\n` +
      `Please download the OAuth Client ID JSON from Google Cloud Console and save it there.`
    );
  }

  // Validate: reasonable bounds
  if (config.pollIntervalMinutes < 1 || config.pollIntervalMinutes > 60) {
    throw new Error('[CONFIG] POLL_INTERVAL_MINUTES must be between 1 and 60');
  }
  if (config.maxConcurrency < 1 || config.maxConcurrency > 20) {
    throw new Error('[CONFIG] MAX_CONCURRENCY must be between 1 and 20');
  }

  // Ensure temp directory exists
  if (!fs.existsSync(config.tempDir)) {
    fs.mkdirSync(config.tempDir, { recursive: true });
  }

  return config;
}

export const CONFIG_DEFAULTS = {
  POLL_INTERVAL_MINUTES: 5,
  MAX_CONCURRENCY: 5,
  SERVER_PORT: 4000,
};

export function saveConfig(updates: Record<string, string>): void {
  const envPath = path.resolve(import.meta.dirname, '..', '.env');
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  }

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `${key}=${value}`);
    } else {
      envContent += `\n${key}=${value}`;
    }
  }

  // clean up extra newlines at start or multiple blank lines
  envContent = envContent.replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf8');
}
