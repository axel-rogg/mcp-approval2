#!/usr/bin/env node
/**
 * Bulk-Migration v1 → v2 fuer Knowledge-Graph-Refs (Skill ↔ Resource-Doc).
 *
 * Liest v1 `kc:objects.usages` pro Skill, sammelt outgoing-Refs, mappt
 * v1→v2-IDs via `meta.v1_id`, POSTet sie als Bulk an
 *   POST /internal/v1/refs/import
 * Service-Token-authed.
 *
 * Idempotent — KC2's addRef hat ON CONFLICT DO NOTHING.
 *
 * Usage:
 *   source /workspaces/mcp-approval/.dev.vars
 *   doppler run --project mcp-approval2 --config privat -- \
 *     env MCP_BEARER_TOKEN="$MCP_BEARER_TOKEN" \
 *     node scripts/migrate-v1-refs.mjs [--dry-run] [--apply]
 *
 * Default-Mode: `--dry-run` (= --apply muss explizit gesetzt sein).
 *
 * PLAN-Ref: docs/plans/active/PLAN-document-linking.md §9 Phase 6.
 */

const V1_MCP_URL = 'https://mcp.ai-toolhub.org/mcp';
const V2_TARGET = 'https://mcp2.ai-toolhub.org';
const USER_EMAIL = process.env.MIGRATE_USER_EMAIL || 'axelrogg@gmail.com';
const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY;

const V1_BEARER = process.env.MCP_BEARER_TOKEN;
const V2_SERVICE_TOKEN = process.env.MCP_APPROVAL_INTERNAL_TOKEN;

if (!V1_BEARER) {
  console.error('FEHLER: MCP_BEARER_TOKEN (v1) nicht gesetzt.');
  process.exit(1);
}
if (!DRY_RUN && !V2_SERVICE_TOKEN) {
  console.error('FEHLER: MCP_APPROVAL_INTERNAL_TOKEN (v2) nicht gesetzt.');
  process.exit(1);
}

// Aus migrate-v1-all.mjs: 3 Skills (v1-IDs).
const SKILL_V1_IDS = [
  'CY00EAGCQZM6C6T1REDNMSFM6Y',
  'CY00EAG5G3CFKEMEN9Y5S7X1RD',
  'CY00EAEA18D6DAN5HYX9SSNVHA',
];

// ─── v1 MCP-Helper (mit Initialize-Handshake) ──────────────────────────────
let v1SessionId = null;

async function v1Rpc(method, params) {
  const headers = {
    authorization: `Bearer ${V1_BEARER}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
  };
  if (v1SessionId) headers['mcp-session-id'] = v1SessionId;
  const res = await fetch(V1_MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e9),
      method,
      params,
    }),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid && !v1SessionId) v1SessionId = sid;
  if (!res.ok) throw new Error(`v1 HTTP ${res.status}: ${await res.text()}`);
  return res;
}

async function v1Initialize() {
  const res = await v1Rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'migrate-v1-refs', version: '0.1.0' },
  });
  await res.text();
  await fetch(V1_MCP_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${V1_BEARER}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...(v1SessionId ? { 'mcp-session-id': v1SessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
}

async function v1ToolsRun(toolId, args) {
  const res = await v1Rpc('tools/call', {
    name: 'tools_run',
    arguments: { tool_id: toolId, arguments: args, wait_ms: 0 },
  });
  const text = await res.text();
  let payload;
  if (text.startsWith('event:')) {
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) throw new Error('SSE response without data line');
    payload = JSON.parse(dataLine.slice(5).trim());
  } else {
    payload = JSON.parse(text);
  }
  if (payload.error) throw new Error(`v1 RPC error: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

function extractData(result) {
  const inner = result.structuredContent?.result ?? result.structuredContent ?? result;
  return (
    inner.structuredContent ??
    (inner.content?.[0]?.text
      ? JSON.parse(inner.content[0].text.replace(/<\/?external-content[^>]*>/g, ''))
      : inner)
  );
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Source: ${V1_MCP_URL}`);
  console.log(`Target: ${V2_TARGET}`);
  console.log(`User:   ${USER_EMAIL}`);
  console.log(`Mode:   ${DRY_RUN ? 'DRY-RUN (no writes)' : 'APPLY'}\n`);

  console.log('v1 MCP-Initialize handshake ...');
  await v1Initialize();
  console.log(`  session-id: ${v1SessionId ?? '(none)'}\n`);

  // 1. Collect outgoing refs per skill from v1.
  const refs = [];
  for (const v1SkillId of SKILL_V1_IDS) {
    process.stdout.write(`  · skill ${v1SkillId} ... `);
    try {
      const result = await v1ToolsRun('kc:objects.usages', { id: v1SkillId });
      const data = extractData(result);
      const outgoing = data.outgoing ?? [];
      if (outgoing.length === 0) {
        console.log('no outgoing refs');
        continue;
      }
      for (const ref of outgoing) {
        // v1 ref shape: { from_id, to_id, role, ... }
        // Mapping v1 'skill_resource' → v2 'resource'
        const v2Role = ref.role === 'skill_resource' ? 'resource' : ref.role;
        refs.push({
          fromV1Id: ref.from_id ?? v1SkillId,
          toV1Id: ref.to_id,
          role: v2Role,
          meta: { v1_role: ref.role },
        });
      }
      console.log(`${outgoing.length} outgoing ref${outgoing.length === 1 ? '' : 's'}`);
    } catch (err) {
      console.log(`FAIL: ${err.message}`);
    }
  }

  console.log(`\nGathered ${refs.length} refs total.\n`);
  if (refs.length === 0) {
    console.log('nothing to migrate.');
    return;
  }

  if (DRY_RUN) {
    console.log('--dry-run — kein POST. Refs die geschickt würden:');
    for (const r of refs) {
      console.log(`  · ${r.fromV1Id} --[${r.role}]→ ${r.toV1Id}`);
    }
    console.log('\nRun with --apply to write.');
    return;
  }

  console.log('POSTing to v2 /internal/v1/refs/import ...');
  const importRes = await fetch(`${V2_TARGET}/internal/v1/refs/import`, {
    method: 'POST',
    headers: {
      'X-Service-Token': V2_SERVICE_TOKEN,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ userEmail: USER_EMAIL, refs }),
  });
  const text = await importRes.text();
  if (!importRes.ok) {
    console.error(`v2 HTTP ${importRes.status}: ${text.slice(0, 1000)}`);
    process.exit(1);
  }
  const result = JSON.parse(text);
  console.log(`\n→ ${result.added.length} refs added:`);
  for (const r of result.added) {
    console.log(`  ✓ ${r.fromV2Id} --[${r.role}]→ ${r.toV2Id}  (v1 ${r.fromV1Id}→${r.toV1Id})`);
  }
  if (result.skipped?.length > 0) {
    console.log(`\n${result.skipped.length} skipped (v1-id not in v2):`);
    for (const s of result.skipped) {
      console.log(`  ⏭ ${s.fromV1Id} --[${s.role}]→ ${s.toV1Id}  (${s.reason})`);
    }
  }
  if (result.errors?.length > 0) {
    console.log(`\n${result.errors.length} errors:`);
    for (const e of result.errors) {
      console.log(`  ✗ ${e.fromV1Id} --[${e.role}]→ ${e.toV1Id}  (${e.message})`);
    }
  }
  console.log('\ndone.');
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
