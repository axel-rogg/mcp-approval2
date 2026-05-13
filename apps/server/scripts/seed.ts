#!/usr/bin/env tsx
/**
 * Dev-Seed: legt einen ersten Admin-User an, fuer Bootstrap-Phase ohne
 * funktionierenden Google-OAuth-Flow.
 *
 * Logik (siehe PLAN §3.3 First-Login-First-Admin):
 *   - Wenn `users` Rows hat → no-op (Status-Sicherheit, keine Race mit
 *     echtem First-Login-Bootstrap).
 *   - Sonst → INSERT users(role='admin', status='active', external_id='seed:<email>').
 *   - Audit-Log Event 'admin.bootstrap.seed' wird emittiert.
 *
 * Usage:
 *   tsx scripts/seed.ts --email=admin@firma.de [--name="Admin"] [--force]
 *
 * Flags:
 *   --email   Pflicht
 *   --name    Optional, default Local-Part der Email
 *   --force   Auch seeden wenn users-Tabelle nicht leer (warn). Vorsicht.
 *
 * Exit-Codes:
 *   0 — success oder skip (mit Hinweis)
 *   1 — DB-Error
 *   2 — bad invocation
 */

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

type Args = { email: string | null; name: string | null; force: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { email: null, name: null, force: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--email=')) args.email = a.slice('--email='.length);
    else if (a.startsWith('--name=')) args.name = a.slice('--name='.length);
    else if (a === '--force') args.force = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: tsx scripts/seed.ts --email=<addr> [--name=<str>] [--force]');
      process.exit(0);
    } else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.email || !args.email.includes('@')) {
    console.error('--email=<addr> required');
    process.exit(2);
  }
  const displayName = args.name ?? args.email.split('@')[0]!;

  const dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) {
    console.error('DATABASE_URL not set');
    process.exit(2);
  }

  const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });
  try {
    // Count active users. Schema: users.status IN ('active','invited','suspended','deleted').
    const [countRow] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM users WHERE status = 'active'
    `;
    const count = Number(countRow?.count ?? 0);

    if (count > 0 && !args.force) {
      console.log(`skip: users-Tabelle hat bereits ${count} active user(s). Nutze --force zum Override.`);
      process.exit(0);
    }
    if (count > 0 && args.force) {
      console.warn(`warn: users-Tabelle hat bereits ${count} active user(s) — --force gesetzt, fahre fort.`);
    }

    // Existing-by-email check (kein Doppel-Insert).
    const existing = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE email = ${args.email}
    `;
    if (existing.length > 0) {
      console.log(`skip: user mit email=${args.email} existiert bereits (id=${existing[0]!.id}).`);
      process.exit(0);
    }

    const id = randomUUID();
    const externalId = `seed:${args.email}`;
    const now = Math.floor(Date.now() / 1000);

    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO users (id, external_id, email, display_name, role, status, created_at)
        VALUES (${id}, ${externalId}, ${args.email!}, ${displayName}, 'admin', 'active', ${now})
      `;
      // Best-effort audit. Wenn das Schema noch unterschiedlich ist, soft-skip.
      try {
        await tx`
          INSERT INTO audit_log (id, ts, actor_user_id, actor_type, action, result, details)
          VALUES (${randomUUID()}, ${now}, ${id}, 'system', 'admin.bootstrap.seed', 'success',
                  ${tx.json({ email: args.email, via: 'seed.ts' })})
        `;
      } catch (e) {
        console.warn('audit-log emit failed (non-fatal):', e instanceof Error ? e.message : e);
      }
    });

    console.log(`seeded admin user:`);
    console.log(`  id          ${id}`);
    console.log(`  email       ${args.email}`);
    console.log(`  display     ${displayName}`);
    console.log(`  role        admin`);
    console.log(`  external_id ${externalId}`);
  } catch (e) {
    console.error('seed failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
