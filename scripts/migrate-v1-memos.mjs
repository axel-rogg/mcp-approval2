#!/usr/bin/env node
/**
 * Memos-Migration v1 → v2.
 *
 * Liest 4 hardgecodete Memo-Bodies aus mcp-approval (kc:objects.get-Export
 * am 2026-05-17) und POSTet sie als generic objects zu v2.
 *
 * Skipt: Test-Junk-Memos (episodic "approval-speed-test", test "Write-Mode
 * smoke") — sind v1-Build-Logs, nicht User-Knowledge.
 *
 * Usage:
 *   doppler run --project mcp-approval2 --config privat -- \
 *     node scripts/migrate-v1-memos.mjs [--dry-run]
 */

const TARGET = process.argv.includes('--target')
  ? process.argv[process.argv.indexOf('--target') + 1]
  : 'https://mcp2.ai-toolhub.org';

const DRY_RUN = process.argv.includes('--dry-run');
const SERVICE_TOKEN = process.env.MCP_APPROVAL_INTERNAL_TOKEN;
const USER_EMAIL = process.env.MIGRATE_USER_EMAIL || 'axelrogg@gmail.com';

if (!DRY_RUN && !SERVICE_TOKEN) {
  console.error('FEHLER: MCP_APPROVAL_INTERNAL_TOKEN nicht gesetzt.');
  process.exit(1);
}

// ─── 4 Memos aus v1 (Test-Junk skipped) ──────────────────────────────────
const MEMOS = [
  {
    subtype: 'memo',
    title: 'Axel Rogg – Name & Adresse',
    description: 'Eigentümer/Nutzer dieses Repos: Axel Rogg, Bahnhofstraße 51c, Wettingen.',
    body: 'Nutzer dieses Repos heißt Axel Rogg und wohnt in der Bahnhofstraße 51c, Wettingen (Schweiz).',
    keywords: ['person', 'axel', 'adresse', 'stammdaten'],
    meta: { scope: 'semantic' },
  },
  {
    subtype: 'memo',
    title: 'Manuel Rogg – Sohn von Axel, geb. 29.04.2006',
    description: 'Manuel Rogg, Sohn von Axel Rogg, geboren 29.04.2006, aktuell 20 Jahre alt.',
    body: 'Axel Roggs Sohn heißt Manuel Rogg, geboren am 29.04.2006 (Stand Mai 2026: 20 Jahre alt).',
    keywords: ['familie', 'sohn', 'axel', 'geburtstag'],
    meta: { scope: 'semantic' },
  },
  {
    subtype: 'memo',
    title: 'Regel: MCP-Approval-Gateway bevorzugen',
    description: 'Axel möchte, dass Claude immer das MCP-Approval-Tool (kc:* gateway) verwendet, wenn möglich.',
    body: 'User-Präferenz (Axel Rogg): Bei Tool-Aufrufen soll Claude bevorzugt das MCP-Approval-Gateway (kc:* / tools_run via f789a2f7-...) verwenden statt direkter/alternativer Tools, wann immer eine äquivalente Fähigkeit dort verfügbar ist. Insbesondere für Speichern/Abrufen von Informationen.',
    keywords: ['regel', 'preference', 'mcp', 'approval', 'procedural'],
    meta: { scope: 'procedural' },
  },
  {
    subtype: 'memo',
    title: 'Regel: MCP-Approval zuerst befragen',
    description: 'Bei Nutzerfragen zuerst im MCP-Approval-Gateway nach personalisiertem Inhalt suchen.',
    body: 'Regel (Axel Rogg): Bei jeder Nutzerfrage ZUERST im MCP-Approval-Gateway nachschauen (kc:search, kc:memorize.search, kc:skills.search). Dort liegt der personalisierte Inhalt — Memos, Docs, Skills, Apps. Erst danach allgemeines Modellwissen heranziehen.',
    keywords: ['regel', 'preference', 'mcp', 'approval', 'procedural', 'search-order'],
    meta: { scope: 'procedural' },
  },
];

async function main() {
  console.log(`Target: ${TARGET}`);
  console.log(`User: ${USER_EMAIL}`);
  console.log(`Dry-run: ${DRY_RUN}`);
  console.log(`Memos: ${MEMOS.length}\n`);

  for (const m of MEMOS) {
    console.log(`  · ${m.title} (scope=${m.meta.scope})`);
  }
  console.log();

  if (DRY_RUN) {
    console.log('dry-run — kein POST.');
    return;
  }

  const body = { userEmail: USER_EMAIL, objects: MEMOS };
  const res = await fetch(`${TARGET}/internal/v1/objects/import`, {
    method: 'POST',
    headers: {
      'X-Service-Token': SERVICE_TOKEN,
      'content-type': 'application/json',
      'accept': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    process.exit(1);
  }
  const result = JSON.parse(text);
  console.log(`→ ${result.imported.length} memos importiert:`);
  for (const m of result.imported) {
    console.log(`  ✓ ${m.id}  ${m.title}`);
  }
  if (result.errors.length > 0) {
    console.log(`\n${result.errors.length} errors:`);
    for (const e of result.errors) {
      console.log(`  ✗ ${e.title}: ${e.message}`);
    }
    process.exit(1);
  }
  console.log('\ndone.');
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
