import type { Config } from 'drizzle-kit';

/**
 * Drizzle-Kit Config — Postgres-Dialect (primary).
 *
 * SQLite-Variante kommt spaeter in Phase 2+ als zweiter Adapter (siehe
 * PLAN-architecture-v1.md §13). Aktuell Postgres-only.
 *
 * DATABASE_URL erwartet:
 *   postgres://app_user:<pw>@localhost:5432/mcp_approval2
 */
export default {
  schema: './src/schema/postgres/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://app_user:dev@localhost:5432/mcp_approval2',
  },
  verbose: true,
  strict: true,
  // Migrations werden hand-geschrieben (siehe migrations/0001_initial.sql) — RLS-
  // Policies und REVOKE-Statements lassen sich nicht aus dem Drizzle-Schema
  // generieren. drizzle-kit wird nur fuer Schema-Diff/Sanity-Check genutzt.
  migrations: {
    table: '__drizzle_migrations__',
    schema: 'public',
  },
} satisfies Config;
