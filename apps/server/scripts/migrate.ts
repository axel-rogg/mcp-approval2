#!/usr/bin/env tsx
/**
 * Production-DB-Migrate-CLI fuer mcp-approval2.
 *
 * Liest apps/server/migrations/NNNN_*.sql, applies in order.
 * Tracking via _migrations(version, name, applied_at, checksum) Tabelle
 * (DDL idempotent via _meta_meta.sql).
 *
 * Plan-Ref: PLAN-architecture-v1.md §12 (Migration-Pipeline).
 *
 * Usage:
 *   tsx scripts/migrate.ts                  — apply all pending
 *   tsx scripts/migrate.ts --dry-run        — show what would apply
 *   tsx scripts/migrate.ts --target=0003    — apply up to (incl.) 0003
 *
 * Env:
 *   DATABASE_URL  — postgres://user:pw@host:port/db (required)
 *
 * Exit-Codes:
 *   0 — success (nothing-to-do counts as success)
 *   1 — operational error (DB unreachable, SQL-error, drift)
 *   2 — bad invocation (unknown flag, missing env)
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const META_FILE = '_meta_meta.sql';

type Args = { dryRun: boolean; target: string | null };

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, target: null };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run' || a === '-n') {
      args.dryRun = true;
    } else if (a.startsWith('--target=')) {
      args.target = a.slice('--target='.length);
    } else if (a === '--help' || a === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      console.error(`unknown flag: ${a}\n${usage()}`);
      process.exit(2);
    }
  }
  return args;
}

function usage(): string {
  return [
    'Usage: tsx scripts/migrate.ts [--dry-run] [--target=NNNN]',
    '',
    '  --dry-run         show what would apply without changing DB',
    '  --target=NNNN     apply up to (incl.) version NNNN',
    '  --help            show this',
    '',
    'Env: DATABASE_URL (required)',
  ].join('\n');
}

type MigrationFile = {
  version: string;          // '0001'
  name: string;             // '0001_initial'
  filename: string;         // '0001_initial.sql'
  fullPath: string;
  content: string;
  checksum: string;
};

function listMigrations(): MigrationFile[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && f !== META_FILE)
    .filter((f) => /^\d{4}_/.test(f))
    .sort();

  return files.map((filename) => {
    const fullPath = join(MIGRATIONS_DIR, filename);
    const content = readFileSync(fullPath, 'utf8');
    const versionMatch = filename.match(/^(\d{4})_(.+)\.sql$/);
    if (!versionMatch) {
      throw new Error(`migration filename does not match NNNN_<name>.sql: ${filename}`);
    }
    const version = versionMatch[1]!;
    const name = `${version}_${versionMatch[2]!}`;
    const checksum = createHash('sha256').update(content).digest('hex');
    return { version, name, filename, fullPath, content, checksum };
  });
}

async function main() {
  const args = parseArgs(process.argv);

  const dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) {
    console.error('DATABASE_URL not set');
    process.exit(2);
  }

  const all = listMigrations();
  if (all.length === 0) {
    console.log('no migration files found in', MIGRATIONS_DIR);
    process.exit(0);
  }

  // Honor --target by truncating the list.
  let candidates = all;
  if (args.target) {
    const idx = all.findIndex((m) => m.version === args.target);
    if (idx < 0) {
      console.error(`target ${args.target} not found among ${all.map((m) => m.version).join(',')}`);
      process.exit(2);
    }
    candidates = all.slice(0, idx + 1);
  }

  const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });

  try {
    // Ensure tracking table exists (idempotent).
    const metaPath = join(MIGRATIONS_DIR, META_FILE);
    const metaSql = readFileSync(metaPath, 'utf8');
    if (args.dryRun) {
      console.log(`[dry-run] would ensure _migrations table from ${META_FILE}`);
    } else {
      await sql.unsafe(metaSql);
    }

    // Fetch applied state. On dry-run before table exists this returns [].
    type AppliedRow = { version: string; name: string; applied_at: string; checksum: string | null };
    let applied: AppliedRow[] = [];
    try {
      applied = await sql<AppliedRow[]>`
        SELECT version, name, applied_at::text, checksum FROM _migrations ORDER BY version ASC
      `;
    } catch (e) {
      if (!args.dryRun) throw e;
      // dry-run + table not yet created → treat as empty
      applied = [];
    }

    const appliedByVersion = new Map(applied.map((r) => [r.version, r]));

    // Drift-Check: applied checksum vs current file checksum.
    const drift: string[] = [];
    for (const m of candidates) {
      const a = appliedByVersion.get(m.version);
      if (a && a.checksum && a.checksum !== m.checksum) {
        drift.push(`${m.version}: applied=${a.checksum.slice(0, 12)} file=${m.checksum.slice(0, 12)}`);
      }
    }
    if (drift.length > 0) {
      console.error('migration drift detected (file content differs from applied):');
      for (const d of drift) console.error('  ' + d);
      console.error('refusing to apply. fix by writing a new forward migration.');
      process.exit(1);
    }

    const pending = candidates.filter((m) => !appliedByVersion.has(m.version));

    if (pending.length === 0) {
      console.log(`up-to-date (${applied.length} applied, ${all.length} total)`);
      process.exit(0);
    }

    console.log(`pending: ${pending.length}`);
    for (const m of pending) console.log(`  ${m.version}  ${m.filename}  (${m.checksum.slice(0, 12)})`);

    if (args.dryRun) {
      console.log('[dry-run] no changes made');
      process.exit(0);
    }

    // Apply each pending migration in its own transaction.
    for (const m of pending) {
      const startMs = Date.now();
      await sql.begin(async (tx) => {
        await tx.unsafe(m.content);
        const appliedAt = Math.floor(Date.now() / 1000);
        await tx`
          INSERT INTO _migrations (version, name, applied_at, checksum)
          VALUES (${m.version}, ${m.name}, ${appliedAt}, ${m.checksum})
        `;
      });
      const dur = Date.now() - startMs;
      console.log(`applied ${m.version} ${m.name} (${dur} ms)`);
    }

    console.log(`done. applied ${pending.length} migration(s).`);
  } catch (e) {
    console.error('migrate failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
