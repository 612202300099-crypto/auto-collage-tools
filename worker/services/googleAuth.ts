/**
 * googleAuth.ts — Authentication layer for Google APIs (OAuth 2.0).
 *
 * This module initializes and exports singleton instances of the Drive
 * and Sheets API clients using OAuth 2.0 Desktop credentials.
 */
import fs from 'fs';
import { google, drive_v3, sheets_v4 } from 'googleapis';
import { logger } from '../utils/logger.ts';

let driveClient: drive_v3.Drive | null = null;
let sheetsClient: sheets_v4.Sheets | null = null;

/**
 * Initialize Google API clients using OAuth 2.0 credentials and token.
 */
export async function initGoogleAuth(credentialsPath: string, tokenPath: string): Promise<void> {
  try {
    logger.info('AUTH', `Loading OAuth Credentials from: ${credentialsPath}`);
    
    if (!fs.existsSync(credentialsPath)) {
      throw new Error(`Credentials file not found at ${credentialsPath}`);
    }

    if (!fs.existsSync(tokenPath)) {
      throw new Error(
        `Token file not found at ${tokenPath}.\n` +
        `You must authenticate first. Please run:\n\n` +
        `   npm run worker:auth\n`
      );
    }

    const credentialsContent = fs.readFileSync(credentialsPath, 'utf8');
    const credentials = JSON.parse(credentialsContent);
    const client = credentials.installed || credentials.web;
    
    if (!client) {
      throw new Error('Invalid credentials.json format. Missing "installed" or "web" key.');
    }

    const { client_secret, client_id, redirect_uris } = client;
    const oAuth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris[0] || 'urn:ietf:wg:oauth:2.0:oob'
    );

    const tokenContent = fs.readFileSync(tokenPath, 'utf8');
    oAuth2Client.setCredentials(JSON.parse(tokenContent));

    // Handle token refresh errors gracefully
    oAuth2Client.on('tokens', (tokens) => {
      if (tokens.refresh_token) {
        // We received a new refresh token, let's merge it and save it
        logger.info('AUTH', 'Received new refresh token from Google');
        const currentTokens = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
        const newTokens = { ...currentTokens, ...tokens };
        fs.writeFileSync(tokenPath, JSON.stringify(newTokens, null, 2));
      }
    });

    // Initialize API clients
    driveClient = google.drive({ version: 'v3', auth: oAuth2Client });
    sheetsClient = google.sheets({ version: 'v4', auth: oAuth2Client });

    logger.success('AUTH', 'Google API clients initialized successfully (OAuth 2.0)');
  } catch (err: any) {
    logger.error('AUTH', `Failed to initialize Google API clients: ${err.message}`);
    throw err;
  }
}

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
