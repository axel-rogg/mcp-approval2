#!/usr/bin/env bash
# setup.sh — initial deploy after the VM is up and .env is configured.
#
# Idempotent: safe to re-run. Skips steps that are already done.
#
# Flow:
#   1. Sanity-check .env + secrets/vertex-sa.json
#   2. Render Caddyfile from template
#   3. docker compose pull
#   4. docker compose up -d (postgres first via healthcheck dependency)
#   5. wait for postgres healthy
#   6. vault-init (idempotent)
#   7. run migrations (approval2 + knowledge2)
#   8. healthcheck

set -euo pipefail

cd "$(dirname "$0")"

# ── Step 1: sanity checks + Doppler-driven .env materialisation ──────
#
# Preferred path: if /opt/mcp-approval2/.doppler-token exists, pull the .env
# fresh from Doppler (Single-Source-of-Truth). Otherwise fall back to an
# existing local .env so emergency operators can still ship without Doppler.
#
# REPO_ROOT is two levels up from this script (deploy/hetzner/setup.sh).
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOPPLER_TOKEN_FILE="${DOPPLER_TOKEN_FILE:-/opt/mcp-approval2/.doppler-token}"

if [[ -f "$DOPPLER_TOKEN_FILE" ]]; then
  echo "→ Doppler token-file present — syncing .env from Doppler ..."
  bash "$REPO_ROOT/scripts/doppler-vm-sync.sh"
else
  echo "WARN: $DOPPLER_TOKEN_FILE missing — Doppler-sync skipped."
  echo "      To enable: terraform output -raw doppler_vm_token"
  echo "                 echo '<token>' > $DOPPLER_TOKEN_FILE && chmod 600 $DOPPLER_TOKEN_FILE"
  echo "                 then re-run bash setup.sh"
  if [[ ! -f .env ]]; then
    echo "ERROR: no .env present and no Doppler-token either — aborting." >&2
    echo "       See docs/runbooks/runbook-doppler.md (Phase 6) for setup." >&2
    exit 1
  fi
  echo "      Falling back to existing local .env."
fi

mkdir -p secrets
if [[ ! -f secrets/vertex-sa.json ]]; then
  # Create a placeholder so the bind-mount doesn't fail. Vertex features
  # will be unavailable until a real SA-JSON is dropped in.
  echo "{}" > secrets/vertex-sa.json
  chmod 600 secrets/vertex-sa.json
  echo "WARN: secrets/vertex-sa.json missing — Vertex AI will be disabled." >&2
fi

# ── Step 2: render Caddyfile ─────────────────────────────────────────
echo "→ Rendering Caddyfile..."
bash render-config.sh

# ── Step 3: pull images ───────────────────────────────────────────────
echo "→ Pulling images (this can take 1-2 minutes on a fresh VM)..."
docker compose pull

# ── Step 4: start the stack ───────────────────────────────────────────
echo "→ Starting services..."
docker compose up -d

# ── Step 5: wait for postgres healthy ────────────────────────────────
echo "→ Waiting for postgres to be healthy..."
TRIES=0
until docker compose exec -T postgres pg_isready -U app -d approval2 >/dev/null 2>&1; do
  TRIES=$((TRIES + 1))
  if (( TRIES > 30 )); then
    echo "ERROR: postgres failed to become healthy after 60s." >&2
    docker compose logs postgres | tail -50
    exit 1
  fi
  sleep 2
done
echo "  ✓ postgres healthy"

# ── Step 6: vault-init (no-op if already initialized) ────────────────
echo "→ Initializing Vault if needed..."
bash vault-init.sh || {
  echo "WARN: vault-init.sh returned non-zero. Continuing — check manually." >&2
}

# ── Step 7: migrations ────────────────────────────────────────────────
# Run via `npx tsx` against the .ts source files shipped in scripts/ — tsc
# does not emit them (tsconfig excludes scripts/). Failure is fatal: an
# empty schema means the next request crashes silently. Run `docker compose
# logs mcp-approval2` if this aborts.
echo "→ Running approval2 migrations..."
docker compose exec -T mcp-approval2 npx tsx scripts/migrate.ts

echo "→ Running knowledge2 migrations..."
docker compose exec -T mcp-knowledge2 npx tsx scripts/migrate.ts

# ── Step 8: healthcheck ───────────────────────────────────────────────
echo "→ Running healthcheck..."
bash healthcheck.sh || {
  echo "WARN: healthcheck reported failures. Investigate above." >&2
}

# ── Final message ─────────────────────────────────────────────────────
# shellcheck disable=SC1091
source .env
cat <<EOF

────────────────────────────────────────────────────────────────────────
Setup complete.

  MCP endpoint:  https://${DOMAIN_MCP}
  Knowledge:     https://${DOMAIN_KNOWLEDGE}
  PWA:           https://${DOMAIN_APP}

Next:
  1. Visit https://${DOMAIN_APP} in your browser.
  2. Log in with the Google account configured in GOOGLE_OAUTH_*.
  3. Enroll a passkey.
  4. Run: bash healthcheck.sh   (anytime, for status)
  5. Run: bash backup.sh        (set up as a cron / systemd-timer)
────────────────────────────────────────────────────────────────────────
EOF
