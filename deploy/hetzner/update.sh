#!/usr/bin/env bash
# update.sh — pull latest code + images, re-render config, restart, migrate.
#
# Idempotent: safe to re-run. No data destruction.
#
# Typical run:
#   ssh deploy@<VM_IP>
#   cd /opt/mcp-approval2/deploy/hetzner
#   bash update.sh

set -euo pipefail

cd "$(dirname "$0")"

# ── Step 1: refresh repo ──────────────────────────────────────────────
# We pull from the parent repo (../..) so this script also picks up changes
# to docker-compose.yml, Caddyfile.tpl, etc.
echo "→ Pulling latest from git..."
(cd ../.. && git pull --ff-only)

# ── Step 2: re-render config (in case Caddyfile.tpl changed) ─────────
echo "→ Re-rendering config..."
bash render-config.sh

# ── Step 3: pull updated images ──────────────────────────────────────
echo "→ Pulling images..."
docker compose pull

# ── Step 4: re-create containers with new images / config ────────────
echo "→ Recreating containers..."
docker compose up -d

# ── Step 5: run any pending migrations ───────────────────────────────
echo "→ Running approval2 migrations..."
docker compose exec -T mcp-approval2 node scripts/migrate.js || \
  echo "WARN: mcp-approval2 migration script not found or failed."

echo "→ Running knowledge2 migrations..."
docker compose exec -T mcp-knowledge2 node scripts/migrate.js || \
  echo "WARN: mcp-knowledge2 migration script not found or failed."

# ── Step 6: reload caddy (zero-downtime config reload) ───────────────
echo "→ Reloading Caddy..."
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile || \
  echo "WARN: caddy reload failed (it may have crashed)."

# ── Step 7: healthcheck ───────────────────────────────────────────────
echo "→ Running healthcheck..."
bash healthcheck.sh

# ── Step 8: prune dangling images (free disk, ignore failures) ───────
echo "→ Pruning dangling images..."
docker image prune -f >/dev/null 2>&1 || true

echo "✓ Update complete."
