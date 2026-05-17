#!/usr/bin/env node
/**
 * Bulk-Migration v1 → v2 fuer Skills + Resources + Onboarding-Docs.
 *
 * Fetcht Bodies live aus v1 (mcp.ai-toolhub.org/mcp via MCP-JSON-RPC mit
 * Bearer) und POSTet sie batched zu v2 /internal/v1/objects/import.
 *
 * Usage:
 *   source /workspaces/mcp-approval/.dev.vars
 *   doppler run --project mcp-approval2 --config privat -- \
 *     env MCP_BEARER_TOKEN="$MCP_BEARER_TOKEN" \
 *     node scripts/migrate-v1-all.mjs [--dry-run]
 */

const V1_MCP_URL = 'https://mcp.ai-toolhub.org/mcp';
const V2_TARGET = 'https://mcp2.ai-toolhub.org';
const USER_EMAIL = process.env.MIGRATE_USER_EMAIL || 'axelrogg@gmail.com';
const DRY_RUN = process.argv.includes('--dry-run');

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

// ─── Items zu migrieren ────────────────────────────────────────────────
// Konvention: subtype + meta-mapping pro Item-Typ.
//
// Skills → subtype='skill_manifest', meta.original_filename, keywords aus kc
// Docs   → subtype='doc',            meta.original_filename
const ITEMS = [
  // 3 Skills
  {
    v1Id: 'CY00EAGCQZM6C6T1REDNMSFM6Y',
    type: 'skill',
    subtype: 'skill_manifest',
    mime: 'text/markdown',
  },
  {
    v1Id: 'CY00EAG5G3CFKEMEN9Y5S7X1RD',
    type: 'skill',
    subtype: 'skill_manifest',
    mime: 'text/markdown',
  },
  {
    v1Id: 'CY00EAEA18D6DAN5HYX9SSNVHA',
    type: 'skill',
    subtype: 'skill_manifest',
    mime: 'text/markdown',
  },
  // 5 Skill-Resources
  {
    v1Id: 'CY00EAGA16CYFYVXBSE7T42EEJ',
    type: 'doc',
    subtype: 'doc',
    mime: 'text/markdown',
  },
  {
    v1Id: 'CY00EAG9683FDK9GA0BV33BQWK',
    type: 'doc',
    subtype: 'doc',
    mime: 'text/html',
  },
  {
    v1Id: 'CY00EAG8BMJ8C0MSNK8BR43XEF',
    type: 'doc',
    subtype: 'doc',
    mime: 'text/markdown',
  },
  {
    v1Id: 'CY00EAG7K2SXEGRZSHYVZ07FCD',
    type: 'doc',
    subtype: 'doc',
    mime: 'text/markdown',
  },
  {
    v1Id: 'CY00EAG5X64E4T4VPJBH4JRM03',
    type: 'doc',
    subtype: 'doc',
    mime: 'text/markdown',
  },
  // 2 Onboarding-Docs
  {
    v1Id: 'CY00EAG41ZT6QC1P5NBHWHKQ02',
    type: 'doc',
    subtype: 'doc',
    mime: 'text/markdown',
  },
  {
    v1Id: 'CY00EAE67V60BG893JGJC1KFAS',
    type: 'doc',
    subtype: 'doc',
    mime: 'text/markdown',
  },
];

// ─── v1-MCP-Call-Helper (mit Initialize-Handshake) ────────────────────
let v1SessionId = null;

async function v1Rpc(method, params) {
  const headers = {
    'authorization': `Bearer ${V1_BEARER}`,
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
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
    clientInfo: { name: 'migrate-v1-all', version: '0.1.0' },
  });
  await res.text(); // discard
  // Send initialized notification
  await fetch(V1_MCP_URL, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${V1_BEARER}`,
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...(v1SessionId ? { 'mcp-session-id': v1SessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
}

async function v1ToolsRun(toolId, args) {
  // v1 exposes user-tools (kc:*) only via the `tools_run`-meta-tool, nicht
  // direkt als MCP tools/call name. So we wrap.
  const res = await v1Rpc('tools/call', {
    name: 'tools_run',
    arguments: { tool_id: toolId, arguments: args, wait_ms: 0 },
  });
  // Server-Sent Events oder JSON — beide parsen
  const text = await res.text();
  let payload;
  if (text.startsWith('event:')) {
    // SSE-format: data: {...}\n\n
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) throw new Error('SSE response without data line');
    payload = JSON.parse(dataLine.slice(5).trim());
  } else {
    payload = JSON.parse(text);
  }
  if (payload.error) throw new Error(`v1 RPC error: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

function decodeBodyB64(b64) {
  return Buffer.from(b64, 'base64').toString('utf-8');
}

// ─── Main ───────────────────────────────────────────────────────────────
async function main() {
  console.log(`Source: ${V1_MCP_URL}`);
  console.log(`Target: ${V2_TARGET}`);
  console.log(`User:   ${USER_EMAIL}`);
  console.log(`Items:  ${ITEMS.length}`);
  console.log(`Dry-run:${DRY_RUN}\n`);

  console.log('v1 MCP-Initialize handshake ...');
  await v1Initialize();
  console.log(`  session-id: ${v1SessionId ?? '(none)'}\n`);

  const objects = [];
  for (const it of ITEMS) {
    process.stdout.write(`  · ${it.v1Id} (${it.type}) ... `);
    try {
      const result = await v1ToolsRun('kc:objects.get', {
        id: it.v1Id,
        expand: ['body'],
      });
      // tools_run wraps the inner kc:* tool result in {status, result}.
      // The actual MCP-content lives in result.structuredContent.result.
      const inner = result.structuredContent?.result ?? result.structuredContent ?? result;
      const data = inner.structuredContent ?? (inner.content?.[0]?.text
        ? JSON.parse(inner.content[0].text.replace(/<\/?external-content[^>]*>/g, ''))
        : inner);
      const body = data.body_b64 ? decodeBodyB64(data.body_b64) : (data.body ?? data.content);
      if (!body) throw new Error('no body in response');
      const meta = {
        v1_id: it.v1Id,
        original_kind: data.kind,
        original_subtype: data.subtype,
        ...(data.filename ? { filename: data.filename } : {}),
      };
      const obj = {
        subtype: it.subtype,
        title: data.title,
        ...(data.description ? { description: data.description.slice(0, 2000) } : {}),
        body,
        mimeType: it.mime,
        meta,
        ...(Array.isArray(data.keywords) && data.keywords.length > 0
          ? { keywords: data.keywords.slice(0, 32) }
          : {}),
      };
      objects.push(obj);
      console.log(`OK (${body.length} chars, "${data.title}")`);
    } catch (err) {
      console.log(`FAIL: ${err.message}`);
    }
  }

  console.log(`\nGathered ${objects.length}/${ITEMS.length} items.\n`);

  if (DRY_RUN) {
    console.log('dry-run — kein POST. Items:');
    for (const o of objects) {
      console.log(`  · [${o.subtype}] ${o.title} (${o.body.length} chars)`);
    }
    return;
  }

  console.log('POSTing to v2 /internal/v1/objects/import ...');
  const importRes = await fetch(`${V2_TARGET}/internal/v1/objects/import`, {
    method: 'POST',
    headers: {
      'X-Service-Token': V2_SERVICE_TOKEN,
      'content-type': 'application/json',
      'accept': 'application/json',
    },
    body: JSON.stringify({ userEmail: USER_EMAIL, objects }),
  });
  const text = await importRes.text();
  if (!importRes.ok) {
    console.error(`v2 HTTP ${importRes.status}: ${text.slice(0, 500)}`);
    process.exit(1);
  }
  const result = JSON.parse(text);
  console.log(`\n→ ${result.imported.length} imported:`);
  for (const o of result.imported) {
    console.log(`  ✓ ${o.id}  [${o.subtype}]  ${o.title}`);
  }
  if (result.errors?.length > 0) {
    console.log(`\n${result.errors.length} errors:`);
    for (const e of result.errors) {
      console.log(`  ✗ ${e.title}: ${e.message}`);
    }
  }
  console.log('\ndone.');
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
