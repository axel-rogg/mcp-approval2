-- _migrations Tracking-Table fuer hand-SQL-Migrations.
-- Plan-Ref: PLAN-architecture-v1.md §12 (Migration-Pipeline).
--
-- Wird vor jeder Migration durch scripts/migrate.ts idempotent angelegt
-- (CREATE TABLE IF NOT EXISTS). Existiert als Standalone-File damit es
-- auch manuell per `psql -f` vorab eingespielt werden kann.
--
-- Tracking-Schema bewusst minimal:
--   version    — Filename-Prefix (z.B. '0001')
--   name       — Filename ohne .sql (z.B. '0001_initial')
--   applied_at — Unix-Epoch-Sekunden (BIGINT) — konsistent mit anderen
--                Tabellen die `INTEGER NOT NULL` nutzen (vgl. users.created_at).
--                PG-INTEGER ist 4-Byte (signed) bis 2038-01-19 — BIGINT macht
--                den Code Y2K38-safe ohne Migrations-Druck.
--   checksum   — sha256 des SQL-Inhalts beim Anwenden (Drift-Detection)

CREATE TABLE IF NOT EXISTS _migrations (
  version    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at BIGINT NOT NULL,
  checksum   TEXT
);
