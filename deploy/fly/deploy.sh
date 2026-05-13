#!/usr/bin/env bash
# =============================================================================
# deploy.sh — first-time deploy of mcp-approval2 to Fly.io.
# =============================================================================
# Plan-Ref: deploy/fly/README.md, docs/runbooks/runbook-fly-deploy.md.
#
# This script is INTERACTIVE — it prints what it's about to do and waits for
# you to confirm at each destructive boundary (create cluster, create app,
# init Vault). Re-running after partial success is safe: `fly` commands are
# idempotent except for `apps create` (which 409s if the app exists; that's
# fine, the script keeps going).
#
# Requirements:
#   - flyctl installed (`curl -L https://fly.io/install.sh | sh`)
#   - `fly auth login` already done
#   - From a machine WITHOUT Zscaler (Coop laptops blocked) — i.e. private
#     network or Codespace.
#
# Usage:
#   bash deploy/fly/deploy.sh           # interactive
#   SKIP_CONFIRM=1 bash deploy/fly/deploy.sh   # CI mode (still aborts on err)
# =============================================================================

set -euo pipefail

APP_NAME="${APP_NAME:-mcp-approval2}"
PG_NAME="${PG_NAME:-${APP_NAME}-pg}"
BAO_NAME="${BAO_NAME:-${APP_NAME}-openbao}"
REGION="${REGION:-fra}"
PG_VOLUME_SIZE="${PG_VOLUME_SIZE:-3}"   # GB, ~1€/month
PG_VM_SIZE="${PG_VM_SIZE:-shared-cpu-1x}"

cd "$(dirname "$0")/../.."   # cd to repo root

confirm() {
  if [[ "${SKIP_CONFIRM:-0}" == "1" ]]; then return 0; fi
  read -r -p "${1} [yes/N]: " ans
  [[ "${ans}" == "yes" ]] || { echo "aborted"; exit 1; }
}

log() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }

# ──────────────────────────────────────────────────────────────────────────
# 0. Pre-flight
# ──────────────────────────────────────────────────────────────────────────
log "Pre-flight: flyctl present? logged in?"
command -v fly >/dev/null || { echo "flyctl not installed"; exit 1; }
fly auth whoami >/dev/null || { echo "run 'fly auth login' first"; exit 1; }
echo "  ✓ flyctl as $(fly auth whoami)"

# ──────────────────────────────────────────────────────────────────────────
# 1. Postgres cluster (managed by Fly).
#    Fly-Postgres = Stolon-based PG cluster with pgvector preinstalled.
# ──────────────────────────────────────────────────────────────────────────
log "Step 1/8: Postgres cluster '${PG_NAME}'"
if fly postgres list 2>/dev/null | grep -q "^${PG_NAME}\b"; then
  echo "  ✓ already exists, skipping create"
else
  confirm "Create Fly Postgres cluster '${PG_NAME}' (~3€/month)?"
  fly postgres create \
    --name "${PG_NAME}" \
    --region "${REGION}" \
    --vm-size "${PG_VM_SIZE}" \
    --volume-size "${PG_VOLUME_SIZE}" \
    --initial-cluster-size 1
fi

# ──────────────────────────────────────────────────────────────────────────
# 2. Create the app shell (so we can attach Postgres + set secrets before
#    the first `fly deploy`).
# ──────────────────────────────────────────────────────────────────────────
log "Step 2/8: App shell '${APP_NAME}'"
if fly apps list 2>/dev/null | awk '{print $1}' | grep -qx "${APP_NAME}"; then
  echo "  ✓ app already exists"
else
  confirm "Create Fly app '${APP_NAME}'?"
  fly apps create "${APP_NAME}" --org personal
fi

# ──────────────────────────────────────────────────────────────────────────
# 3. Attach Postgres → sets DATABASE_URL secret in ${APP_NAME}.
#    The attach command is idempotent for the existing user.
# ──────────────────────────────────────────────────────────────────────────
log "Step 3/8: Attach Postgres → ${APP_NAME}"
if fly secrets list -a "${APP_NAME}" 2>/dev/null | grep -q '^DATABASE_URL '; then
  echo "  ✓ DATABASE_URL already set, skipping attach"
else
  fly postgres attach "${PG_NAME}" --app "${APP_NAME}"
fi

# ──────────────────────────────────────────────────────────────────────────
# 4. Enable pgvector + pgcrypto in the attached database.
# ──────────────────────────────────────────────────────────────────────────
log "Step 4/8: Enable pgvector + pgcrypto on '${PG_NAME}'"
# `fly postgres connect` opens a psql tunnel; we pipe the init SQL.
fly postgres connect -a "${PG_NAME}" -d "${APP_NAME//-/_}" \
  < deploy/fly/postgres-init.sql || {
    echo "  ! init failed — inspect manually with 'fly postgres connect'"
    exit 1
  }

# ──────────────────────────────────────────────────────────────────────────
# 5. OpenBao sidecar.
# ──────────────────────────────────────────────────────────────────────────
log "Step 5/8: OpenBao app '${BAO_NAME}'"
if fly apps list 2>/dev/null | awk '{print $1}' | grep -qx "${BAO_NAME}"; then
  echo "  ✓ OpenBao app already exists"
else
  confirm "Create OpenBao app '${BAO_NAME}'?"
  fly apps create "${BAO_NAME}" --org personal
fi
fly deploy --config fly.openbao.toml --remote-only

echo
echo "  ===================================================================="
echo "  MANUAL STEP: Initialize OpenBao."
echo "  Run, in a separate terminal:"
echo "     fly ssh console -a ${BAO_NAME}"
echo "  Inside the container:"
echo "     bao operator init -key-shares=3 -key-threshold=2"
echo "  → SAVE the 3 unseal keys + the root token OUT-OF-BAND."
echo "     bao operator unseal <key1>"
echo "     bao operator unseal <key2>"
echo "     bao login <root-token>"
echo "     bao secrets enable -path=transit transit"
echo "     bao write -f transit/keys/mcp-approval2-kek"
echo "  ===================================================================="
confirm "OpenBao initialized + unsealed + transit-engine enabled?"

# ──────────────────────────────────────────────────────────────────────────
# 6. Generate runtime secrets.
#    JWT_RS256_*_PEM = 2048-bit RSA for service-JWTs to mcp-knowledge2.
#    MCP_BEARER_TOKEN = first-party bearer used in `Authorization` headers.
#    SESSION_SIGNING_KEY = HMAC-SHA256 for session-JWTs.
#    MCP_APPROVAL_INTERNAL_TOKEN = pre-shared for /internal/v1/*.
# ──────────────────────────────────────────────────────────────────────────
log "Step 6/8: Generate + set secrets"
TMPDIR_KEYS="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_KEYS}"' EXIT

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out "${TMPDIR_KEYS}/priv.pem" 2>/dev/null
openssl rsa -in "${TMPDIR_KEYS}/priv.pem" -pubout \
  -out "${TMPDIR_KEYS}/pub.pem" 2>/dev/null

MCP_BEARER_TOKEN="$(openssl rand -hex 32)"
SESSION_SIGNING_KEY="$(openssl rand -base64 64 | tr -d '\n')"
MCP_APPROVAL_INTERNAL_TOKEN="$(openssl rand -base64 48 | tr -d '\n')"
JWT_KID="key-$(date -u +%Y%m%d)"

echo "  Generated secrets (NOT printed). Pushing to Fly..."
fly secrets set --app "${APP_NAME}" --stage \
  MCP_BEARER_TOKEN="${MCP_BEARER_TOKEN}" \
  SESSION_SIGNING_KEY="${SESSION_SIGNING_KEY}" \
  MCP_APPROVAL_INTERNAL_TOKEN="${MCP_APPROVAL_INTERNAL_TOKEN}" \
  JWT_KID="${JWT_KID}" \
  JWT_RS256_PRIVATE_KEY_PEM="$(cat "${TMPDIR_KEYS}/priv.pem")" \
  JWT_RS256_PUBLIC_KEY_PEM="$(cat "${TMPDIR_KEYS}/pub.pem")"

echo
echo "  Note: GOOGLE_OAUTH_CLIENT_ID/_SECRET, VAULT_TOKEN (AppRole),"
echo "  MASTER_KEY_BASE64 (dev fallback), KNOWLEDGE_URL etc. are NOT set"
echo "  by this script — push them manually after deploy with:"
echo "     fly secrets set --app ${APP_NAME} GOOGLE_OAUTH_CLIENT_ID=…"
echo "  See deploy/fly/README.md §6 for the full list."
confirm "Continue to deploy?"

# ──────────────────────────────────────────────────────────────────────────
# 7. Deploy the application (this pushes the staged secrets + image).
# ──────────────────────────────────────────────────────────────────────────
log "Step 7/8: Deploy '${APP_NAME}'"
fly deploy --config fly.toml --remote-only

# ──────────────────────────────────────────────────────────────────────────
# 8. Run DB migrations.
# ──────────────────────────────────────────────────────────────────────────
log "Step 8/8: Run migrations"
fly ssh console -a "${APP_NAME}" -C "node /app/apps/server/scripts/migrate.js"

log "Done."
echo "  https://${APP_NAME}.fly.dev/health"
echo "  fly logs -a ${APP_NAME}     # tail"
echo "  fly status -a ${APP_NAME}   # machine state"
