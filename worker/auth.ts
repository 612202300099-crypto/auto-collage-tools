/**
 * auth.ts — Standalone script to generate an OAuth 2.0 token.
 *
 * Usage:
 *   npm run worker:auth
 *
 * This script will output a Google Login URL. The user must open it,
 * login with their Google account, and paste the authorization code back.
 * The script exchanges the code for a token and saves it to token.json.
 */
import fs from 'fs';
import readline from 'readline';
import { google } from 'googleapis';
import { loadConfig } from './config.ts';

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets'
];

async function generateToken() {
  console.log('\n  ╔═══════════════════════════════════════════════════╗');
  console.log('  ║        🔑 OAuth 2.0 Token Generator               ║');
  console.log('  ╚═══════════════════════════════════════════════════╝\n');

  try {
    const config = loadConfig();

    // Read credentials.json
    const content = fs.readFileSync(config.googleCredentialsPath, 'utf8');
    const credentials = JSON.parse(content);
    
    // Support both installed (desktop) and web app credentials
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

    // Generate Auth URL
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline', // Required to get a refresh token
      scope: SCOPES,
      prompt: 'consent'       // Force consent screen to ensure refresh token is provided
    });

    console.log('Authorize this app by visiting this url:\n');
    console.log('\x1b[36m%s\x1b[0m\n', authUrl); // Cyan color for URL

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question('Enter the authorization code here: ', async (code) => {
      rl.close();
      
      try {
        console.log('Exchanging code for token...');
        const { tokens } = await oAuth2Client.getToken(code.trim());
        
        fs.writeFileSync(config.googleTokenPath, JSON.stringify(tokens, null, 2));
        
        console.log('\n✅ Token stored successfully to:', config.googleTokenPath);
        console.log('You can now run the worker: npm run worker:auto\n');
      } catch (err: any) {
        console.error('\n❌ Error retrieving access token:', err.message);
      }
    });

  } catch (err: any) {
    console.error('\n❌ Setup Error:', err.message);
    process.exit(1);
  }
}

generateToken();
