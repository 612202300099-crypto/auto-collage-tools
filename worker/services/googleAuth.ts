/**
 * googleAuth.ts — Authentication layer for Google APIs.
 *
 * Supports TWO authentication methods (auto-detected):
 *
 * 1. Service Account (recommended for workers)
 *    → credentials.json contains "type": "service_account"
 *    → No login needed, no token.json needed
 *    → Just share Drive folders & Spreadsheets with the service account email
 *
 * 2. OAuth 2.0 Desktop (legacy/interactive)
 *    → credentials.json contains "installed" or "web"
 *    → Requires running `npm run worker:auth` first to generate token.json
 */
import fs from 'fs';
import { google, drive_v3, sheets_v4 } from 'googleapis';
import { logger } from '../utils/logger.ts';

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
];

let driveClient: drive_v3.Drive | null = null;
let sheetsClient: sheets_v4.Sheets | null = null;

/**
 * Initialize Google API clients.
 * Auto-detects whether to use Service Account or OAuth 2.0.
 */
export async function initGoogleAuth(credentialsPath: string, tokenPath: string): Promise<void> {
  try {
    logger.info('AUTH', `Loading credentials from: ${credentialsPath}`);

    if (!fs.existsSync(credentialsPath)) {
      throw new Error(`Credentials file not found at ${credentialsPath}`);
    }

    const credentialsContent = fs.readFileSync(credentialsPath, 'utf8');
    const credentials = JSON.parse(credentialsContent);

    // Auto-detect auth method based on credentials file content
    if (credentials.type === 'service_account') {
      await initServiceAccount(credentials);
    } else if (credentials.installed || credentials.web) {
      await initOAuth2(credentials, credentialsPath, tokenPath);
    } else {
      throw new Error(
        'Invalid credentials.json format.\n' +
        'Expected either a Service Account key (with "type": "service_account")\n' +
        'or an OAuth 2.0 client ID (with "installed" or "web" key).\n\n' +
        'Download from: https://console.cloud.google.com/apis/credentials'
      );
    }

    logger.success('AUTH', 'Google API clients initialized successfully');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('AUTH', `Failed to initialize Google API clients: ${message}`);
    throw err;
  }
}

// ─── Service Account Auth ────────────────────────────────────────────────────

async function initServiceAccount(credentials: Record<string, unknown>): Promise<void> {
  const email = credentials.client_email as string;
  logger.info('AUTH', `Using Service Account: ${email}`);
  logger.info('AUTH', '💡 Make sure Drive folders & Spreadsheets are shared with this email!');

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: SCOPES,
  });

  const authClient = await auth.getClient();

  driveClient = google.drive({ version: 'v3', auth: authClient as any });
  sheetsClient = google.sheets({ version: 'v4', auth: authClient as any });

  logger.success('AUTH', `Authenticated as Service Account: ${email}`);
}

// ─── OAuth 2.0 Auth ──────────────────────────────────────────────────────────

async function initOAuth2(
  credentials: Record<string, unknown>,
  credentialsPath: string,
  tokenPath: string,
): Promise<void> {
  logger.info('AUTH', 'Using OAuth 2.0 Desktop credentials');

  if (!fs.existsSync(tokenPath)) {
    throw new Error(
      `Token file not found at ${tokenPath}.\n` +
      `You must authenticate first. Please run:\n\n` +
      `   npm run worker:auth\n`
    );
  }

  const client = (credentials as any).installed || (credentials as any).web;

  const { client_secret, client_id, redirect_uris } = client;
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0] || 'urn:ietf:wg:oauth:2.0:oob'
  );

  const tokenContent = fs.readFileSync(tokenPath, 'utf8');
  oAuth2Client.setCredentials(JSON.parse(tokenContent));

  // Handle token refresh — save new tokens automatically
  oAuth2Client.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      logger.info('AUTH', 'Received new refresh token from Google');
      const currentTokens = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      const newTokens = { ...currentTokens, ...tokens };
      fs.writeFileSync(tokenPath, JSON.stringify(newTokens, null, 2));
    }
  });

  driveClient = google.drive({ version: 'v3', auth: oAuth2Client });
  sheetsClient = google.sheets({ version: 'v4', auth: oAuth2Client });

  logger.success('AUTH', 'Authenticated via OAuth 2.0');
}

// ─── Client Getters ──────────────────────────────────────────────────────────

export function getDriveClient(): drive_v3.Drive {
  if (!driveClient) {
    throw new Error('Drive client not initialized. Call initGoogleAuth first.');
  }
  return driveClient;
}

export function getSheetsClient(): sheets_v4.Sheets {
  if (!sheetsClient) {
    throw new Error('Sheets client not initialized. Call initGoogleAuth first.');
  }
  return sheetsClient;
}
