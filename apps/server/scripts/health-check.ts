#!/usr/bin/env tsx
/**
 * Live-Reachability-Check fuer mcp-approval2-Dependencies.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2 (Architektur-Uebersicht, Dependencies).
 *
 * Checks (parallel ausgefuehrt):
 *   - db        — Postgres: SELECT 1
 *   - vault     — OpenBao: GET /v1/sys/health
 *   - kc2       — mcp-knowledge2: GET /health
 *   - vertex    — Vertex-AI: GET discovery (NUR wenn VERTEX_AI_PROJECT_ID gesetzt)
 *
 * Output: JSON auf stdout, eine Zeile pro Check + Summary.
 *   { "ok": true, "checks": [ { "name": "db", "ok": true, "ms": 12, ... }, ... ] }
 *
 * Exit-Codes:
 *   0 — alle aktivierten Checks gruen
 *   1 — mindestens ein Check failed
 *
 * Env:
 *   DATABASE_URL           required fuer db-check
 *   VAULT_ADDR             default http://127.0.0.1:8200
 *   KC2_URL                default http://127.0.0.1:8787 (kc2 dev-default)
 *   VERTEX_AI_PROJECT_ID   optional, aktiviert vertex-check
 *   VERTEX_AI_LOCATION     default europe-west4
 */

import postgres from 'postgres';

type CheckResult = {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
  skipped?: boolean;
};

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T | null; err: Error | null; ms: number }> {
  const start = Date.now();
  try {
    const result = await fn();
    return { result, err: null, ms: Date.now() - start };
  } catch (e) {
    return { result: null, err: e instanceof Error ? e : new Error(String(e)), ms: Date.now() - start };
  }
}

async function checkDb(): Promise<CheckResult> {
  const url = process.env['DATABASE_URL'];
  if (!url) return { name: 'db', ok: false, ms: 0, skipped: true, detail: 'DATABASE_URL not set' };
  const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 5 });
  try {
    const { err, ms } = await timed(() => sql`SELECT 1 AS one`);
    if (err) return { name: 'db', ok: false, ms, detail: err.message };
    return { name: 'db', ok: true, ms };
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

async function checkVault(): Promise<CheckResult> {
  const addr = process.env['VAULT_ADDR'] ?? 'http://127.0.0.1:8200';
  const { result, err, ms } = await timed(async () => {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 5000);
    try {
      return await fetch(`${addr}/v1/sys/health`, { signal: ac.signal });
    } finally {
      clearTimeout(to);
    }
  });
  if (err) return { name: 'vault', ok: false, ms, detail: err.message };
  // Vault returns 200 (active), 429 (standby), 472 (DR-secondary), 503 (sealed/uninitialized).
  // Fuer Bootstrap erlauben wir 200+429+501; alles andere = not-ok.
  const status = result!.status;
  const ok = [200, 429, 501].includes(status);
  return { name: 'vault', ok, ms, detail: `status=${status}` };
}

async function checkKc2(): Promise<CheckResult> {
  const url = process.env['KC2_URL'] ?? 'http://127.0.0.1:8787';
  const { result, err, ms } = await timed(async () => {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 5000);
    try {
      return await fetch(`${url}/health`, { signal: ac.signal });
    } finally {
      clearTimeout(to);
    }
  });
  if (err) return { name: 'kc2', ok: false, ms, detail: err.message };
  const ok = result!.ok;
  return { name: 'kc2', ok, ms, detail: `status=${result!.status}` };
}

async function checkVertex(): Promise<CheckResult> {
  const project = process.env['VERTEX_AI_PROJECT_ID'];
  if (!project) return { name: 'vertex', ok: true, ms: 0, skipped: true, detail: 'VERTEX_AI_PROJECT_ID not set' };
  // Wir machen NUR einen DNS+TLS-Reachability-Check gegen den regionalen
  // Endpoint — voller API-Call wuerde Service-Account-Auth brauchen, das
  // sprengt den Scope eines Health-Checks.
  const location = process.env['VERTEX_AI_LOCATION'] ?? 'europe-west4';
  const host = `${location}-aiplatform.googleapis.com`;
  const { result, err, ms } = await timed(async () => {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 5000);
    try {
      // /$discovery/rest ist public und antwortet ohne Auth (oder mit 401, beides = reachable)
      return await fetch(`https://${host}/$discovery/rest?version=v1`, { signal: ac.signal });
    } finally {
      clearTimeout(to);
    }
  });
  if (err) return { name: 'vertex', ok: false, ms, detail: err.message };
  // reachable wenn HTTP-Response (auch 401/403)
  const ok = result!.status < 500;
  return { name: 'vertex', ok, ms, detail: `host=${host} status=${result!.status}` };
}

async function main() {
  if (process.argv.some((a) => a === '--help' || a === '-h')) {
    console.log('Usage: tsx scripts/health-check.ts');
    console.log('Env: DATABASE_URL, VAULT_ADDR, KC2_URL, VERTEX_AI_PROJECT_ID');
    process.exit(0);
  }

  const checks = await Promise.all([checkDb(), checkVault(), checkKc2(), checkVertex()]);
  const failures = checks.filter((c) => !c.ok && !c.skipped);
  const ok = failures.length === 0;

  console.log(JSON.stringify({ ok, checks }, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
