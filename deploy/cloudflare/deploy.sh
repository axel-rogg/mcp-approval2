#!/usr/bin/env bash
# =============================================================================
# deploy.sh — one-shot Cloudflare bootstrap + deploy for mcp-approval2.
# =============================================================================
# This is the BRINGUP script for a brand-new CF account. After the first run
# you only need `wrangler deploy` (or push to main if you wire GitHub Actions).
#
# Run from repo root:   bash deploy/cloudflare/deploy.sh
#
# Prereqs:
#   - npm install (root)
#   - wrangler logged in: `npx wrangler login`
#   - openssl available for key generation
#
# What it does (idempotent — safe to re-run):
#   1. Create D1 database `mcp-approval2` (skips if it exists)
#   2. Patch wrangler.jsonc with the new D1 database_id
#   3. Create R2 bucket `mcp-approval2-eu` (skips if exists)
#   4. Create Vectorize index `mcp-approval2-objects` (skips if exists)
#   5. Prompt operator to set required secrets via `wrangler secret put`
#   6. Run D1 migrations against the remote DB
#   7. Deploy worker
#
# Architecture caveats live in apps/server/src/cf/README.md and the runbook at
# docs/runbooks/runbook-cloudflare-deploy.md — read those before running.
# =============================================================================
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly WRANGLER_CONFIG="${REPO_ROOT}/wrangler.jsonc"

readonly D1_NAME="mcp-approval2"
readonly R2_NAME="mcp-approval2-eu"
readonly VEC_NAME="mcp-approval2-objects"
readonly VEC_DIM=768
readonly VEC_METRIC="cosine"

readonly REQUIRED_SECRETS=(
  GOOGLE_OAUTH_CLIENT_ID
  GOOGLE_OAUTH_CLIENT_SECRET
  MASTER_KEY
  JWT_SECRET
  JWT_RS256_PRIVATE_KEY_PEM
  JWT_RS256_PUBLIC_KEY_PEM
  JWT_KID
  MCP_APPROVAL_INTERNAL_TOKEN
)

cd "${REPO_ROOT}"

log() {
  printf '\033[1;36m[deploy]\033[0m %s\n' "$*"
}
warn() {
  printf '\033[1;33m[warn]\033[0m %s\n' "$*"
}
err() {
  printf '\033[1;31m[err]\033[0m %s\n' "$*" >&2
}

if ! command -v npx >/dev/null 2>&1; then
  err "npx not found. Install Node.js >= 20 first."
  exit 1
fi

WRANGLER="npx --yes wrangler"

# ----------------------------------------------------------------------------
# 1) D1 database
# ----------------------------------------------------------------------------
log "Checking D1 database ${D1_NAME}…"
existing_d1_id="$(${WRANGLER} d1 list --json 2>/dev/null \
  | node -e "const dbs=JSON.parse(require('fs').readFileSync(0,'utf8'));
             const m=dbs.find(d=>d.name==='${D1_NAME}');
             process.stdout.write(m?m.uuid:'');" 2>/dev/null || true)"

if [[ -n "${existing_d1_id}" ]]; then
  log "D1 ${D1_NAME} already exists: ${existing_d1_id}"
  D1_ID="${existing_d1_id}"
else
  log "Creating D1 ${D1_NAME}…"
  create_out="$(${WRANGLER} d1 create "${D1_NAME}")"
  D1_ID="$(echo "${create_out}" | grep -oE '"database_id":\s*"[^"]+"' | head -1 \
            | sed -E 's/.*"database_id":\s*"([^"]+)".*/\1/')"
  if [[ -z "${D1_ID}" ]]; then
    # Newer wrangler prints `database_id = "<uuid>"` on stdout — fall back to that.
    D1_ID="$(echo "${create_out}" | grep -oE 'database_id\s*=\s*"[^"]+"' | head -1 \
              | sed -E 's/.*database_id\s*=\s*"([^"]+)".*/\1/')"
  fi
  if [[ -z "${D1_ID}" ]]; then
    err "Could not parse D1 database_id from wrangler output. Manual fix needed."
    echo "${create_out}"
    exit 1
  fi
  log "D1 created: ${D1_ID}"
fi

# Patch wrangler.jsonc with the resolved id (idempotent — only writes if changed).
if grep -q "REPLACE_ME_AFTER_wrangler_d1_create" "${WRANGLER_CONFIG}" \
   || ! grep -q "\"database_id\": \"${D1_ID}\"" "${WRANGLER_CONFIG}"; then
  log "Patching ${WRANGLER_CONFIG} with database_id=${D1_ID}"
  # macOS + linux sed compat via tmpfile
  tmpfile="$(mktemp)"
  sed -E "s|\"database_id\":[[:space:]]*\"[^\"]*\"|\"database_id\": \"${D1_ID}\"|" \
    "${WRANGLER_CONFIG}" >"${tmpfile}"
  mv "${tmpfile}" "${WRANGLER_CONFIG}"
fi

# ----------------------------------------------------------------------------
# 2) R2 bucket (EU jurisdiction)
# ----------------------------------------------------------------------------
log "Checking R2 bucket ${R2_NAME}…"
if ${WRANGLER} r2 bucket list 2>/dev/null | grep -q "^${R2_NAME}$"; then
  log "R2 ${R2_NAME} already exists"
else
  log "Creating R2 ${R2_NAME} (EU)…"
  ${WRANGLER} r2 bucket create "${R2_NAME}" --jurisdiction eu
fi

# ----------------------------------------------------------------------------
# 3) Vectorize index
# ----------------------------------------------------------------------------
log "Checking Vectorize index ${VEC_NAME}…"
if ${WRANGLER} vectorize list 2>/dev/null | grep -q "${VEC_NAME}"; then
  log "Vectorize ${VEC_NAME} already exists"
else
  log "Creating Vectorize ${VEC_NAME} (${VEC_DIM}d ${VEC_METRIC})…"
  ${WRANGLER} vectorize create "${VEC_NAME}" \
    --dimensions="${VEC_DIM}" \
    --metric="${VEC_METRIC}"
  # Declare metadata fields we want to filter on. Belt-and-suspenders
  # alongside the prefixed-id namespacing in vectorize-adapter.ts.
  log "Declaring filterable metadata fields (namespace, owner_id, kind)…"
  for field in namespace owner_id kind; do
    ${WRANGLER} vectorize create-metadata-index "${VEC_NAME}" \
      --property-name="${field}" --type=string || \
      warn "Could not declare metadata index for ${field} (already exists?)"
  done
fi

# ----------------------------------------------------------------------------
# 4) Secrets
# ----------------------------------------------------------------------------
log "Checking secrets…"
existing_secrets="$(${WRANGLER} secret list --name mcp-approval2 2>/dev/null | tr -d ' "' || true)"

missing=()
for s in "${REQUIRED_SECRETS[@]}"; do
  if ! echo "${existing_secrets}" | grep -q "name:${s},"; then
    missing+=("${s}")
  fi
done

if (( ${#missing[@]} > 0 )); then
  warn "The following secrets are not yet set:"
  for s in "${missing[@]}"; do
    printf '   - %s\n' "${s}"
  done
  cat <<'EOF'

Run these commands to set them (paste the value when prompted):

  npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
  npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
  npx wrangler secret put MASTER_KEY                  # openssl rand -base64 32
  npx wrangler secret put JWT_SECRET                  # openssl rand -hex 32
  npx wrangler secret put JWT_RS256_PRIVATE_KEY_PEM   # PKCS#8 PEM body
  npx wrangler secret put JWT_RS256_PUBLIC_KEY_PEM    # SPKI PEM body
  npx wrangler secret put JWT_KID                     # any stable string id
  npx wrangler secret put MCP_APPROVAL_INTERNAL_TOKEN # openssl rand -hex 32

Generate the RS256 keypair with:
  openssl genpkey -algorithm RSA -out priv.pem -pkeyopt rsa_keygen_bits:2048
  openssl pkey -in priv.pem -pubout -out pub.pem

Re-run this script once all secrets are in place.
EOF
  exit 2
fi

# ----------------------------------------------------------------------------
# 5) Migrations
# ----------------------------------------------------------------------------
log "Running D1 migrations against remote ${D1_NAME}…"
${WRANGLER} d1 migrations apply "${D1_NAME}" --remote

# ----------------------------------------------------------------------------
# 6) Deploy
# ----------------------------------------------------------------------------
log "Deploying worker…"
${WRANGLER} deploy

log "Done. Verify with: curl https://mcp-approval2.<your-account>.workers.dev/health"
log "Smoke test: open the URL above + check /v1/auth/google/start works."
