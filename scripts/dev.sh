#!/usr/bin/env bash
# scripts/dev.sh — Greenfield local-dev bootstrap for mcp-approval2.
#
# Usage:
#   bash scripts/dev.sh            # full bootstrap + dev-server
#   bash scripts/dev.sh --no-serve # bootstrap only, don't start the dev-server
#
# Steps:
#   1. Ensure .env exists (copy from .env.example if missing)
#   2. docker compose up -d (Postgres + OpenBao + MinIO)
#   3. Wait for Postgres healthy
#   4. Init OpenBao transit-engine (idempotent)
#   5. Run drizzle migrations
#   6. Start `npm run dev -w apps/server` (unless --no-serve)
#
# Prereqs: docker, docker compose v2, node >=20, npm.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

NO_SERVE=0
for arg in "$@"; do
  case "$arg" in
    --no-serve) NO_SERVE=1 ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
  esac
done

log() { printf '\033[1;36m[dev.sh]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[dev.sh]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[dev.sh]\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. .env ───────────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  if [[ -f .env.example ]]; then
    cp .env.example .env
    log ".env created from .env.example — review values before committing secrets."
  else
    fail ".env.example not found; cannot bootstrap .env."
  fi
fi

# Export .env for docker compose's substitution and for child scripts.
set -a
# shellcheck disable=SC1091
source .env
set +a

# ── 2. docker compose up ──────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  fail "docker not found. Install Docker Desktop or docker-engine and retry."
fi
if ! docker compose version >/dev/null 2>&1; then
  fail "docker compose v2 not available. Upgrade Docker to a recent version."
fi

log "Starting docker compose services (postgres, openbao, minio)…"
docker compose up -d

# ── 3. Wait for Postgres ──────────────────────────────────────────────
log "Waiting for Postgres to become healthy…"
for i in {1..60}; do
  status="$(docker inspect -f '{{.State.Health.Status}}' mcp-approval2-postgres 2>/dev/null || echo missing)"
  if [[ "$status" == "healthy" ]]; then
    log "Postgres healthy."
    break
  fi
  if [[ $i -eq 60 ]]; then
    fail "Postgres did not become healthy within 60s. Check 'docker compose logs postgres'."
  fi
  sleep 1
done

# Ensure pgvector extension is present (image ships it, but the user-DB needs CREATE EXTENSION).
log "Ensuring pgvector extension is enabled in ${DATABASE_NAME:-mcp_approval2}…"
docker exec -e PGPASSWORD="${DATABASE_PASSWORD:-postgres}" mcp-approval2-postgres \
  psql -U "${DATABASE_USER:-postgres}" -d "${DATABASE_NAME:-mcp_approval2}" \
  -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null

# ── 4. OpenBao transit-engine ────────────────────────────────────────
log "Bootstrapping OpenBao transit-engine…"
bash "$REPO_ROOT/scripts/vault-init.sh" || warn "vault-init.sh exited non-zero — continuing (transit may already be set up)."

# ── 5. Run migrations ────────────────────────────────────────────────
log "Running database migrations…"
if [[ -d apps/server/migrations ]] && [[ -n "$(ls -A apps/server/migrations 2>/dev/null || true)" ]]; then
  if npm run db:migrate --workspace=apps/server --if-present; then
    log "Migrations applied."
  else
    warn "db:migrate failed or no migrate script. Run 'npm install' first if you haven't, then 'npm run db:migrate -w apps/server'."
  fi
else
  warn "No migrations found in apps/server/migrations — skipping (Phase 0: schema-tbd)."
fi

# ── 6. Start dev-server ──────────────────────────────────────────────
if [[ $NO_SERVE -eq 1 ]]; then
  log "Bootstrap complete. Skipping dev-server (--no-serve)."
  exit 0
fi

# Does the server workspace actually expose a `dev` script?
if node -e "process.exit(Object.keys(require('./apps/server/package.json').scripts||{}).includes('dev')?0:1)" 2>/dev/null; then
  log "Starting dev-server (apps/server)…"
  exec npm run dev --workspace=apps/server
else
  warn "apps/server has no 'dev' script yet (Phase 0). Bootstrap complete — start the server manually when ready."
  log "Services running:"
  log "  Postgres : postgres://${DATABASE_USER:-postgres}:***@localhost:5432/${DATABASE_NAME:-mcp_approval2}"
  log "  OpenBao  : ${VAULT_ADDR:-http://localhost:8200}  (token: \$VAULT_TOKEN)"
  log "  MinIO    : ${S3_ENDPOINT:-http://localhost:9000}  (console: http://localhost:9001)"
fi
