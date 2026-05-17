#!/usr/bin/env node
/**
 * One-shot Migration: v1 sub_mcp_servers + gateway_oauth_tokens → v2.
 *
 * Liest aus V1's D1 die OAuth-Metadaten (authorize_url/token_url/scopes/
 * client_id) plus Server-Stammdaten (name/url) und POSTet zu v2
 * /internal/v1/servers/import.
 *
 * NICHT migriert: refresh_token_enc + client_secret_enc — KMS-encrypted mit
 * V1-Worker-KEK, Cross-Runtime-Decrypt out-of-scope. User klickt in V2 einmal
 * "Authorize" pro Server (im Auth-Tab #/tools/servers/<name>/auth).
 *
 * Usage:
 *   doppler run --project mcp-approval --config prd -- \
 *     doppler run --project mcp-approval2 --config privat -- \
 *     node scripts/migrate-v1-servers.mjs [--dry-run] [--target URL]
 *
 *   Or with explicit CF creds:
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
 *     MCP_APPROVAL_INTERNAL_TOKEN=... \
 *     node scripts/migrate-v1-servers.mjs
 *
 * Erwartet:
 *   - CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (fuer wrangler d1)
 *   - MCP_APPROVAL_INTERNAL_TOKEN (V2 service-token)
 *
 * Flags:
 *   --dry-run                  Zeigt was gesendet wuerde, keine HTTP-Calls
 *   --target https://...       V2-Origin (default mcp2.ai-toolhub.org)
 *   --d1-database <name>       V1-D1-Name (default mcp-approval)
 *   --user-email <email>       Default axelrogg@gmail.com
 */

import { execSync } from 'node:child_process';

const TARGET = process.argv.includes('--target')
  ? process.argv[process.argv.indexOf('--target') + 1]
  : 'https://mcp2.ai-toolhub.org';

const D1_NAME = process.argv.includes('--d1-database')
  ? process.argv[process.argv.indexOf('--d1-database') + 1]
  : 'mcp-approval';

const USER_EMAIL = process.argv.includes('--user-email')
  ? process.argv[process.argv.indexOf('--user-email') + 1]
  : process.env.MIGRATE_USER_EMAIL || 'axelrogg@gmail.com';

const DRY_RUN = process.argv.includes('--dry-run');
const SERVICE_TOKEN = process.env.MCP_APPROVAL_INTERNAL_TOKEN;

if (!DRY_RUN && !SERVICE_TOKEN) {
  console.error('FEHLER: MCP_APPROVAL_INTERNAL_TOKEN nicht gesetzt (V2 service-token).');
  process.exit(1);
}
if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.error('FEHLER: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID brauchen wir fuer wrangler d1 query.');
  process.exit(1);
}

// ─── 1. Server-Stammdaten aus V1-D1 lesen ────────────────────────────────

function d1Query(sql) {
  // Wir nutzen wrangler d1 execute --json. Erwartet wrangler im PATH.
  const cmd = `npx wrangler d1 execute ${D1_NAME} --remote --json --command ${JSON.stringify(sql)}`;
  let raw;
  try {
    raw = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    console.error(`wrangler d1 execute failed: ${err.message}`);
    if (err.stderr) console.error(err.stderr.toString());
    process.exit(1);
  }
  // Wrangler-Output ist eine Liste mit einem Item. Result-Rows liegen in [0].results
  const parsed = JSON.parse(raw);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first?.results ?? [];
}

console.log(`\n[v1→v2 server-migration] target=${TARGET} user=${USER_EMAIL} dry-run=${DRY_RUN}\n`);
console.log('1. Lese sub_mcp_servers / gateway_servers aus V1-D1...');

// V1 hat 2 Tables: 'gateway_servers' (alt) und evtl 'sub_mcp_servers' (neu).
// Wir versuchen beide, nehmen was existiert.
let servers = [];
try {
  servers = d1Query('SELECT id, name, url, auth_type, enabled FROM gateway_servers WHERE enabled = 1');
} catch {
  console.error('  gateway_servers nicht lesbar — abbruch');
  process.exit(1);
}
console.log(`  Gefunden: ${servers.length} aktive gateway_servers`);

console.log('\n2. Lese gateway_oauth_tokens (Metadaten ohne Refresh-Tokens)...');
const oauthRows = d1Query(
  'SELECT server_id, scopes, authorization_endpoint, token_endpoint, client_id FROM gateway_oauth_tokens',
);
console.log(`  Gefunden: ${oauthRows.length} OAuth-Metadaten-Rows`);

const oauthByServerId = new Map(oauthRows.map((r) => [r.server_id, r]));

// ─── 2. Filter auf OAuth-Server (cf, github) + zu V2-Payload mappen ──────

const TO_MIGRATE = new Set(['cf', 'github']);

const payload = [];
for (const s of servers) {
  if (!TO_MIGRATE.has(s.name)) {
    console.log(`  · skip ${s.name} (nicht in TO_MIGRATE)`);
    continue;
  }
  const oauth = oauthByServerId.get(s.id);
  if (!oauth) {
    console.log(`  · skip ${s.name}: kein gateway_oauth_tokens-Row (vermutlich Bearer-only)`);
    continue;
  }
  const scopes = (oauth.scopes ?? '')
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
  payload.push({
    name: s.name,
    displayName: s.name === 'github' ? 'GitHub' : s.name === 'cf' ? 'Cloudflare' : s.name,
    baseUrl: s.url,
    authMode: 'oauth',
    oauth: {
      provider: s.name === 'github' ? 'github' : s.name === 'cf' ? 'cloudflare' : s.name,
      kind: 'pre', // V1 hatte beide, aber wir migrieren als pre — V2 unterstuetzt DCR nicht
      authorize_url: oauth.authorization_endpoint,
      token_url: oauth.token_endpoint,
      scopes,
      client_id: oauth.client_id,
    },
  });
  console.log(`  ✓ ${s.name}: ${s.url} (scopes=${scopes.join(',') || '-'})`);
}

if (payload.length === 0) {
  console.log('\nKeine OAuth-Server zu migrieren. Done.');
  process.exit(0);
}

console.log(`\n3. Migriere ${payload.length} Server zu V2...`);

if (DRY_RUN) {
  console.log('\n--- DRY RUN: would POST ---');
  console.log(JSON.stringify({ userEmail: USER_EMAIL, servers: payload }, null, 2));
  console.log('\n--- end dry-run ---');
  process.exit(0);
}

const res = await fetch(`${TARGET}/internal/v1/servers/import`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-service-token': SERVICE_TOKEN,
  },
  body: JSON.stringify({ userEmail: USER_EMAIL, servers: payload }),
});
const body = await res.text();
console.log(`HTTP ${res.status}`);
console.log(body);

if (!res.ok) process.exit(1);

console.log('\n✓ Done.\n');
console.log('Naechste Schritte:');
console.log(`  1. PWA aufrufen: ${TARGET.replace('mcp2', 'app2')}/#/tools/servers`);
for (const s of payload) {
  console.log(`  2. Auf "${s.name}" Card klicken → Auth-Tab → Client-Secret eintragen → ▶ Authorize`);
}
console.log('     (Refresh-Tokens werden frisch erzeugt — V1-Tokens sind nicht migriert.)\n');
