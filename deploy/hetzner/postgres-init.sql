-- postgres-init.sql — runs once at first postgres container start
--
-- The docker-entrypoint creates:
--   user:       app
--   password:   $POSTGRES_PASSWORD
--   database:   approval2 (POSTGRES_DB)
--
-- We add the second database (knowledge2) + required extensions in both.

-- ── knowledge2 database ────────────────────────────────────────────────
CREATE DATABASE knowledge2 OWNER app;

-- ── approval2 extensions ───────────────────────────────────────────────
\c approval2
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- pgvector is not strictly required for approval2 today, but a single
-- pgvector image keeps both DBs aligned and lets approval2 query vectors
-- via FDW or replication later without re-bootstrapping.
CREATE EXTENSION IF NOT EXISTS vector;

-- ── knowledge2 extensions ──────────────────────────────────────────────
\c knowledge2
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Reproducibility: force UTC on both DBs ────────────────────────────
ALTER DATABASE approval2  SET timezone TO 'UTC';
ALTER DATABASE knowledge2 SET timezone TO 'UTC';
