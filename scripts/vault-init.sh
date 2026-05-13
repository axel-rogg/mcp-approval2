#!/usr/bin/env bash
# scripts/vault-init.sh — Bootstrap OpenBao for mcp-approval2.
#
# Dev-mode OpenBao auto-initializes and unseals with a root-token equal to
# $VAULT_TOKEN. This script:
#   1. Waits for /v1/sys/health to report sealed=false
#   2. Enables the transit-engine at $VAULT_TRANSIT_PATH (default 'transit')
#   3. Creates a sample key 'transit/keys/user-default' for smoke-tests
#   4. Prints status
#
# Idempotent: running twice is safe (skips already-existing mounts/keys).
#
# Usage:
#   bash scripts/vault-init.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\033[1;36m[vault-init]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[vault-init]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[vault-init]\033[0m %s\n' "$*" >&2; exit 1; }

if [[ -f .env ]]; then
  set -a; source .env; set +a
fi

VAULT_ADDR="${VAULT_ADDR:-http://localhost:8200}"
VAULT_TOKEN="${VAULT_TOKEN:-root-dev-token-CHANGE-IN-PROD}"
TRANSIT_PATH="${VAULT_TRANSIT_PATH:-transit}"

if ! command -v curl >/dev/null 2>&1; then
  fail "curl is required."
fi

# ── 1. Wait for /v1/sys/health ────────────────────────────────────────
log "Waiting for OpenBao at $VAULT_ADDR …"
for i in {1..30}; do
  if response="$(curl -fsS "$VAULT_ADDR/v1/sys/health" 2>/dev/null)"; then
    if echo "$response" | grep -q '"sealed":false'; then
      log "OpenBao initialized and unsealed."
      break
    fi
  fi
  if [[ $i -eq 30 ]]; then
    fail "OpenBao did not become healthy within 30s. Check 'docker compose logs openbao'."
  fi
  sleep 1
done

# Helper: call the Bao API with the root-token.
vault_api() {
  local method="$1"; shift
  local path="$1"; shift
  curl -fsS -X "$method" \
    -H "X-Vault-Token: $VAULT_TOKEN" \
    -H "Content-Type: application/json" \
    "$VAULT_ADDR$path" \
    "$@"
}

# Helper that allows 200 / 204 / 400 (mount-exists) without aborting the script.
vault_api_tolerant() {
  local method="$1"; shift
  local path="$1"; shift
  local http_code
  http_code="$(curl -s -o /dev/null -w '%{http_code}' \
    -X "$method" \
    -H "X-Vault-Token: $VAULT_TOKEN" \
    -H "Content-Type: application/json" \
    "$VAULT_ADDR$path" \
    "$@")"
  echo "$http_code"
}

# ── 2. Enable transit-engine ──────────────────────────────────────────
log "Checking transit-engine mount at '$TRANSIT_PATH/' …"
mounts="$(vault_api GET /v1/sys/mounts)"
if echo "$mounts" | grep -q "\"$TRANSIT_PATH/\""; then
  log "Transit-engine already mounted at '$TRANSIT_PATH/'."
else
  log "Enabling transit-engine at '$TRANSIT_PATH/' …"
  code="$(vault_api_tolerant POST "/v1/sys/mounts/$TRANSIT_PATH" \
    --data '{"type":"transit"}')"
  if [[ "$code" == "204" || "$code" == "200" ]]; then
    log "Transit-engine enabled."
  elif [[ "$code" == "400" ]]; then
    # 400 = "path is already in use" — race with another bootstrap, treat as success.
    warn "Transit mount POST returned 400 (already in use) — continuing."
  else
    fail "Failed to enable transit-engine (HTTP $code)."
  fi
fi

# ── 3. Create sample key user-default ─────────────────────────────────
log "Ensuring sample key '$TRANSIT_PATH/keys/user-default' exists…"
key_check_code="$(vault_api_tolerant GET "/v1/$TRANSIT_PATH/keys/user-default")"
if [[ "$key_check_code" == "200" ]]; then
  log "Key 'user-default' already exists."
elif [[ "$key_check_code" == "404" ]]; then
  log "Creating key 'user-default' (type=aes256-gcm96)…"
  code="$(vault_api_tolerant POST "/v1/$TRANSIT_PATH/keys/user-default" \
    --data '{"type":"aes256-gcm96"}')"
  if [[ "$code" == "204" || "$code" == "200" ]]; then
    log "Key 'user-default' created."
  else
    fail "Failed to create key 'user-default' (HTTP $code)."
  fi
else
  warn "Unexpected HTTP $key_check_code while checking key. Continuing."
fi

# ── 4. Status ─────────────────────────────────────────────────────────
log "Status summary:"
log "  VAULT_ADDR     = $VAULT_ADDR"
log "  Transit-mount  = $TRANSIT_PATH/"
log "  Sample key     = $TRANSIT_PATH/keys/user-default"
log "  Root-token     = (see \$VAULT_TOKEN in .env)"
log "Tip: 'bash scripts/vault-shell.sh' opens a CLI shell."
