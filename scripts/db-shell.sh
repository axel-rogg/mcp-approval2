#!/usr/bin/env bash
# scripts/db-shell.sh — Open a psql shell against the local Postgres.
#
# Usage:
#   bash scripts/db-shell.sh                 # interactive psql
#   bash scripts/db-shell.sh -c "SELECT 1"   # one-shot query
#
# Reads connection creds from .env.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ -f .env ]]; then
  set -a; source .env; set +a
fi

DB_USER="${DATABASE_USER:-postgres}"
DB_NAME="${DATABASE_NAME:-mcp_approval2}"
DB_PASSWORD="${DATABASE_PASSWORD:-postgres}"

if ! docker ps --format '{{.Names}}' | grep -q '^mcp-approval2-postgres$'; then
  echo "[db-shell] postgres container not running. Run 'bash scripts/dev.sh' first." >&2
  exit 1
fi

# Use docker exec -it so psql gets a tty when stdin is interactive; fall back
# to non-interactive when called with -c "...".
if [[ $# -gt 0 ]]; then
  exec docker exec -e PGPASSWORD="$DB_PASSWORD" mcp-approval2-postgres \
    psql -U "$DB_USER" -d "$DB_NAME" "$@"
else
  exec docker exec -it -e PGPASSWORD="$DB_PASSWORD" mcp-approval2-postgres \
    psql -U "$DB_USER" -d "$DB_NAME"
fi
