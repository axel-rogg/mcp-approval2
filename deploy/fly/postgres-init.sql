-- =============================================================================
-- postgres-init.sql — bootstrap script for the Fly-Postgres cluster.
-- =============================================================================
-- Plan-Ref: deploy/fly/deploy.sh §3, apps/server/migrations/0001_initial.sql.
--
-- Fly Postgres ships with the pgvector extension available (it's compiled
-- into the image) but NOT enabled in each DB. We need it for objects_vec
-- (vector(768) embeddings from Vertex AI text-embedding-005).
--
-- pgcrypto is needed for gen_random_uuid() in 0001_initial.sql.
--
-- Run this against the `mcp_approval2` database (created by
-- `fly postgres attach`) BEFORE running `db:migrate`. Sequence in deploy.sh:
--   fly postgres connect -a mcp-approval2-pg -d mcp_approval2 < postgres-init.sql
--   fly ssh console -a mcp-approval2 -C "node apps/server/scripts/migrate.js"
--
-- Idempotent — safe to re-run.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- Sanity check — `\dx` after running this should show both extensions.
DO $$
BEGIN
  RAISE NOTICE 'extensions installed: %, %',
    (SELECT extversion FROM pg_extension WHERE extname = 'pgcrypto'),
    (SELECT extversion FROM pg_extension WHERE extname = 'vector');
END
$$;
