#!/usr/bin/env bash
# scripts/db-reset.sh — Nuke local Postgres, recreate, re-migrate.
#
# DESTRUCTIVE: deletes the postgres-data Docker volume. Use only in dev.
#
# Usage:
#   bash scripts/db-reset.sh          # interactive confirm
#   bash scripts/db-reset.sh --yes    # skip confirm (CI / scripted)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\033[1;36m[db-reset]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[db-reset]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[db-reset]\033[0m %s\n' "$*" >&2; exit 1; }

CONFIRM=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) CONFIRM=1 ;;
  esac
done

if [[ $CONFIRM -ne 1 ]]; then
  warn "About to DELETE the mcp-approval2-postgres-data volume."
  warn "All local DB content will be lost."
  read -r -p "Type 'reset' to confirm: " ans
  [[ "$ans" == "reset" ]] || fail "Aborted."
fi

# Load .env so DATABASE_* vars are visible to compose substitution.
if [[ -f .env ]]; then
  set -a; source .env; set +a
fi

log "Stopping postgres container…"
docker compose stop postgres || true
docker compose rm -f postgres || true

log "Removing volume mcp-approval2-postgres-data…"
docker volume rm mcp-approval2-postgres-data 2>/dev/null || \
  warn "Volume already absent or in use by another container."

log "Recreating postgres container…"
docker compose up -d postgres

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

log "Enabling pgvector extension…"
docker exec -e PGPASSWORD="${DATABASE_PASSWORD:-postgres}" mcp-approval2-postgres \
  psql -U "${DATABASE_USER:-postgres}" -d "${DATABASE_NAME:-mcp_approval2}" \
  -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null

log "Running migrations…"
if [[ -d apps/server/migrations ]] && [[ -n "$(ls -A apps/server/migrations 2>/dev/null || true)" ]]; then
  npm run db:migrate --workspace=apps/server --if-present || \
    warn "Migration step failed — check apps/server/migrations and drizzle config."
else
  warn "No migrations found — fresh schema (Phase 0: schema-tbd)."
fi

log "Reset complete."
