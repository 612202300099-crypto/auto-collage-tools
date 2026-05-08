/**
 * config.ts — Environment-based configuration for the Worker.
 *
 * Multi-shop configuration: each shop has its own spreadsheet and Drive folder.
 * Shops are configured via SHOPS env var (JSON array) for maximum flexibility.
 *
 * All configuration is read from environment variables (.env)
 * with sensible defaults. Validation is performed at startup.
 */
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import type { WorkerConfig, ShopConfig } from './types.ts';

// Load .env from root project (one level above worker/)
dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env') });

function requireEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] || defaultValue;
  if (!value) {
    throw new Error(`[CONFIG] Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Parse SHOPS configuration from environment.
 * Accepts a JSON array string.
 *
 * Example:
 * SHOPS='[{"name":"CustomeBase","spreadsheetId":"abc123"}]'
 */
function parseShopsConfig(): ShopConfig[] {
  const raw = process.env.SHOPS;
  if (!raw) {
    throw new Error(
      '[CONFIG] Missing SHOPS environment variable.\n' +
      'Please configure shops as a JSON array. Example:\n\n' +
      'SHOPS=\'[{"name":"MyShop","spreadsheetId":"abc123"}]\'\n'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      '[CONFIG] Invalid SHOPS JSON format. Please check syntax.\n' +
      `Current value: ${raw.substring(0, 100)}...`
    );
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('[CONFIG] SHOPS must be a non-empty JSON array');
  }

  const shops: ShopConfig[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const shop = parsed[i] as Record<string, unknown>;

    if (!shop.name || typeof shop.name !== 'string') {
      throw new Error(`[CONFIG] Shop #${i + 1}: "name" is required (string)`);
    }
    if (!shop.spreadsheetId || typeof shop.spreadsheetId !== 'string') {
      throw new Error(`[CONFIG] Shop "${shop.name}": "spreadsheetId" is required (string)`);
    }

    shops.push({
      name: shop.name,
      spreadsheetId: shop.spreadsheetId,
      sheetName: (shop.sheetName as string) || 'FOTO POLAROID',
      polaroidFolderName: (shop.polaroidFolderName as string) || 'POLAROID',
      columns: shop.columns as ShopConfig['columns'],
    });
  }

  return shops;
}

export function loadConfig(): WorkerConfig {
  const shops = parseShopsConfig();

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
    shops,
    editorText: process.env.EDITOR_TEXT || '',
    pollIntervalMinutes: parseInt(process.env.POLL_INTERVAL_MINUTES || '5', 10),
    maxConcurrency: parseInt(process.env.MAX_CONCURRENCY || '5', 10),
    tempDir: path.resolve(import.meta.dirname, '..', '.tmp-worker'),
    enableFaceDetection: process.env.ENABLE_FACE_DETECTION !== 'false',
    dryRun: process.env.DRY_RUN === 'true',
    serverPort: parseInt(process.env.WORKER_PORT || '4000', 10),
    secondaryDriveFolderId: process.env.SECONDARY_DRIVE_FOLDER_ID,
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
