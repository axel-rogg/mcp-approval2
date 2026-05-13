# Migrations

Plan-Ref: [PLAN-architecture-v1.md](../../../docs/plans/active/PLAN-architecture-v1.md) §3, §5, §6.

Hand-geschriebene SQL-Migrations fuer mcp-approval2. RLS-Policies und
`REVOKE`-Statements lassen sich nicht aus dem Drizzle-Schema generieren — daher
ist diese Datei die Source-of-Truth fuer DDL. Das Drizzle-Schema unter
[../src/schema/postgres/](../src/schema/postgres/) ist ein 1:1-Mirror fuer
Application-Code (Query-Builder, Type-Inference).

## Ablauf

### 1. Postgres-Container hochfahren

Lokal via docker-compose (siehe Repo-Root `docker-compose.yml` — kommt in
Phase 0):

```bash
npm run docker:up
```

### 2. Connection-User anlegen (einmalig)

```sql
-- als superuser:
CREATE ROLE app_user WITH LOGIN PASSWORD '<dev-pw>';
GRANT CONNECT ON DATABASE mcp_approval2 TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT INSERT, SELECT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT INSERT, SELECT, UPDATE, DELETE ON TABLES TO app_user;
```

Die Migration `0001_initial.sql` REVOKEt anschliessend automatisch
`UPDATE, DELETE` auf `audit_log` von `app_user` — Append-only-Constraint.

### 3. Migration anwenden

```bash
psql "$DATABASE_URL" -f migrations/0001_initial.sql
```

Idempotent: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
`CREATE POLICY` via `DO $$ ... pg_policies` Check. Mehrfache Ausfuehrung ist
sicher.

### 4. Schema-Sanity-Check via Drizzle-Kit

```bash
npm run db:generate    # Drizzle-Schema → SQL-Diff (sollte leer sein)
```

Wenn `db:generate` ein Diff ausspuckt: entweder Schema-Drift (jemand hat die
TS-Definition geaendert ohne Migration zu schreiben) oder es fehlt eine
Migration. NICHT die generierte SQL direkt anwenden — sondern eine neue
`0002_*.sql` handschreiben mit RLS-Statements falls noetig.

## Connection-Setup im App-Code

Vor jeder Query muss die Connection den `app.current_user`-GUC setzen, damit
RLS-Policies greifen:

```ts
await db.execute(sql`SET LOCAL app.current_user = ${userId}`);
const docs = await db.select().from(documents);
```

Das passiert in der Auth-Middleware (Phase 1). Bei System-Crons (kein User-
Context): mit superuser ODER ohne RLS-Tabellen arbeiten.

## Neue Migration schreiben

1. Drizzle-Schema unter `src/schema/postgres/` aendern.
2. `npm run db:generate` ausfuehren — generiertes SQL als Startpunkt nutzen.
3. SQL als `migrations/000N_<beschreibung>.sql` speichern.
4. RLS-Policies + REVOKE-Statements + IF NOT EXISTS-Guards manuell hinzufuegen.
5. Idempotent halten — Migration muss ohne Fehler zweimal laufen koennen.
6. `psql $DATABASE_URL -f` zum Testen.

## TODOs

- [ ] Phase 1: separater `app_admin_ro`-User fuer Audit-Read-View
- [ ] Phase 1: Cron-Job fuer `revoked_jtis`-Cleanup (Eintraege > expires_at)
- [ ] Phase 1: Migrations-Tracking-Tabelle (`__drizzle_migrations__` wird von
      drizzle-kit verwaltet, hand-SQL aber nicht — entweder selbst tracken
      oder pure Drizzle-Kit-Migrate verwenden ohne SQL-Files)
