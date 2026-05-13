#!/usr/bin/env tsx
/**
 * Migration-Status-Report fuer mcp-approval2.
 *
 * Listet alle Migrations-Files unter apps/server/migrations/ und zeigt
 * pro Eintrag: applied? wann? Checksum-Drift?
 *
 * Plan-Ref: PLAN-architecture-v1.md §12.
 *
 * Usage: tsx scripts/migrate-status.ts [--json]
 *
 * Exit-Codes:
 *   0 — report ok (auch wenn pending oder drift — Status-Tool, kein Gate)
 *   1 — DB unreachable
 *   2 — bad invocation
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const META_FILE = '_meta_meta.sql';

type Row = {
  version: string;
  name: string;
  filename: string;
  applied: boolean;
  applied_at: number | null;
  checksum_file: string;
  checksum_applied: string | null;
  drift: boolean;
};

async function main() {
  const asJson = process.argv.includes('--json');
  if (process.argv.some((a) => a === '--help' || a === '-h')) {
    console.log('Usage: tsx scripts/migrate-status.ts [--json]');
    process.exit(0);
  }

  const dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) {
    console.error('DATABASE_URL not set');
    process.exit(2);
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && f !== META_FILE)
    .filter((f) => /^\d{4}_/.test(f))
    .sort();

  const fileRows = files.map((filename) => {
    const content = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
    const m = filename.match(/^(\d{4})_(.+)\.sql$/)!;
    return {
      version: m[1]!,
      name: `${m[1]!}_${m[2]!}`,
      filename,
      checksum_file: createHash('sha256').update(content).digest('hex'),
    };
  });

  const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });
  try {
    type AppliedRow = { version: string; applied_at: string; checksum: string | null };
    let applied: AppliedRow[] = [];
    try {
      applied = await sql<AppliedRow[]>`
        SELECT version, applied_at::text, checksum FROM _migrations
      `;
    } catch {
      // table not yet created — treat as empty
      applied = [];
    }
    const byVersion = new Map(applied.map((r) => [r.version, r]));

    const rows: Row[] = fileRows.map((f) => {
      const a = byVersion.get(f.version);
      const checksum_applied = a?.checksum ?? null;
      const drift = !!(a && checksum_applied && checksum_applied !== f.checksum_file);
      return {
        version: f.version,
        name: f.name,
        filename: f.filename,
        applied: !!a,
        applied_at: a ? Number(a.applied_at) : null,
        checksum_file: f.checksum_file,
        checksum_applied,
        drift,
      };
    });

    if (asJson) {
      console.log(JSON.stringify({ migrations: rows }, null, 2));
      return;
    }

    const W_VER = 6;
    const W_STAT = 9;
    const W_NAME = 40;
    console.log(
      'version'.padEnd(W_VER) +
        '  status'.padEnd(W_STAT + 2) +
        '  name'.padEnd(W_NAME + 2) +
        '  applied_at',
    );
    console.log('-'.repeat(W_VER + W_STAT + W_NAME + 30));
    for (const r of rows) {
      const status = r.drift ? 'DRIFT' : r.applied ? 'applied' : 'pending';
      const at = r.applied_at ? new Date(r.applied_at * 1000).toISOString() : '-';
      console.log(
        r.version.padEnd(W_VER) +
          '  ' +
          status.padEnd(W_STAT) +
          '  ' +
          r.name.padEnd(W_NAME) +
          '  ' +
          at,
      );
    }
    const pending = rows.filter((r) => !r.applied).length;
    const drift = rows.filter((r) => r.drift).length;
    console.log(`\nsummary: ${rows.length} total, ${rows.length - pending} applied, ${pending} pending, ${drift} drift`);
  } catch (e) {
    console.error('status failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
