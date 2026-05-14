#!/usr/bin/env bash
# vault-init.sh — initialize OpenBao after the first `docker compose up -d`.
#
# Idempotent: if Vault is already initialized/unsealed, this is a no-op.
#
# What it does:
#   1. `bao operator init` (3 unseal keys, threshold 2)  → saves keys offline
#   2. unseals using 2 of the 3 keys
#   3. enables the `transit` secrets engine (used for DEK wrapping)
#   4. enables AppRole auth + creates the `mcp-approval2` role + policy
#   5. prints the values to put into .env
#
# After this script:
#   - Edit .env: set VAULT_TOKEN=<root_token> (or use AppRole creds for prod)
#   - Run: docker compose up -d --force-recreate mcp-approval2
#
# IMPORTANT: the unseal keys are written to `.vault-init-output-<ts>.json`
# (chmod 600). BACK THEM UP OFFLINE BEFORE THE NEXT REBOOT.

set -euo pipefail

VAULT_CONTAINER="${VAULT_CONTAINER:-mcp-openbao}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"

# Sanity: container must be running.
if ! docker ps --format '{{.Names}}' | grep -qx "$VAULT_CONTAINER"; then
  echo "ERROR: container '$VAULT_CONTAINER' is not running." >&2
  echo "       Did you run 'docker compose -f $COMPOSE_FILE up -d openbao'?" >&2
  exit 1
fi

# Sanity: jq is required.
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq not found. Install with: apt-get install jq" >&2
  exit 1
fi

# Detect if Vault is already initialized. `bao status` exits non-zero when
# Vault is sealed OR uninitialized; we parse the output instead.
STATUS=$(docker exec -e BAO_ADDR=http://127.0.0.1:8200 "$VAULT_CONTAINER" bao status -format=json 2>/dev/null || true)
INITIALIZED=$(echo "$STATUS" | jq -r '.initialized // false' 2>/dev/null || echo "false")
SEALED=$(echo "$STATUS" | jq -r '.sealed // true' 2>/dev/null || echo "true")

if [[ "$INITIALIZED" == "true" && "$SEALED" == "false" ]]; then
  echo "Vault is already initialized and unsealed. Skipping init."
  exit 0
fi

if [[ "$INITIALIZED" == "true" && "$SEALED" == "true" ]]; then
  echo "ERROR: Vault is initialized but sealed. Unseal manually:" >&2
  echo "       docker exec -it $VAULT_CONTAINER bao operator unseal <key>" >&2
  exit 1
fi

# OpenBao runs the `bao server` process as user `openbao` (uid 100),
# but the named docker volume `vault-data` is owned by root after creation.
# Without this chown, `bao operator init` fails with
#   "failed to persist keyring: permission denied"
# inside /vault/data. Idempotent — re-runs are no-ops.
echo "→ Fixing /vault/data ownership for the openbao user..."
docker exec "$VAULT_CONTAINER" chown -R openbao:openbao /vault/data

# ─── Step 1: operator init ────────────────────────────────────────────
echo "→ Initializing Vault (3 unseal keys, threshold 2)..."
INIT_OUT=$(docker exec -e BAO_ADDR=http://127.0.0.1:8200 "$VAULT_CONTAINER" bao operator init \
  -format=json -key-shares=3 -key-threshold=2)

ROOT_TOKEN=$(echo "$INIT_OUT" | jq -r '.root_token')
KEY1=$(echo "$INIT_OUT" | jq -r '.unseal_keys_b64[0]')
KEY2=$(echo "$INIT_OUT" | jq -r '.unseal_keys_b64[1]')

# Persist init output offline (chmod 600).
OUT_FILE=".vault-init-output-$(date -u +%Y%m%d-%H%M%S).json"
echo "$INIT_OUT" > "$OUT_FILE"
chmod 600 "$OUT_FILE"
echo "  → Init output saved to $OUT_FILE (chmod 600)."
echo "  → BACK THIS FILE UP OFFLINE NOW. Losing it = losing all encrypted data."

# ─── Step 2: unseal ───────────────────────────────────────────────────
echo "→ Unsealing Vault..."
docker exec -e BAO_ADDR=http://127.0.0.1:8200 "$VAULT_CONTAINER" bao operator unseal "$KEY1" >/dev/null
docker exec -e BAO_ADDR=http://127.0.0.1:8200 "$VAULT_CONTAINER" bao operator unseal "$KEY2" >/dev/null

# ─── Step 3: enable transit engine ────────────────────────────────────
echo "→ Enabling transit secrets engine..."
docker exec -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN="$ROOT_TOKEN" "$VAULT_CONTAINER" \
  bao secrets enable -path=transit transit || \
  echo "  (transit already enabled, continuing)"

# ─── Step 4: AppRole auth + mcp-approval2 policy ──────────────────────
echo "→ Writing policy 'mcp-approval2'..."
docker exec -i -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN="$ROOT_TOKEN" "$VAULT_CONTAINER" \
  bao policy write mcp-approval2 - <<'POLICY'
# mcp-approval2 needs full transit access (encrypt/decrypt DEKs).
path "transit/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}

# Token introspection (for token-renewal at runtime).
path "auth/token/lookup-self" {
  capabilities = ["read"]
}
path "auth/token/renew-self" {
  capabilities = ["update"]
}
POLICY

echo "→ Enabling AppRole auth method..."
docker exec -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN="$ROOT_TOKEN" "$VAULT_CONTAINER" \
  bao auth enable approle 2>/dev/null || \
  echo "  (approle already enabled, continuing)"

echo "→ Creating AppRole 'mcp-approval2'..."
docker exec -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN="$ROOT_TOKEN" "$VAULT_CONTAINER" \
  bao write auth/approle/role/mcp-approval2 \
    token_policies=mcp-approval2 \
    token_ttl=1h \
    token_max_ttl=4h

ROLE_ID=$(docker exec -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN="$ROOT_TOKEN" "$VAULT_CONTAINER" \
  bao read -format=json auth/approle/role/mcp-approval2/role-id | \
  jq -r '.data.role_id')

SECRET_ID=$(docker exec -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN="$ROOT_TOKEN" "$VAULT_CONTAINER" \
  bao write -format=json -f auth/approle/role/mcp-approval2/secret-id | \
  jq -r '.data.secret_id')

# ─── Done ─────────────────────────────────────────────────────────────
cat <<EOF

────────────────────────────────────────────────────────────────────────
Vault init complete.

Add ONE of the following to .env:

  Option A — root token (simpler, dev only):
    VAULT_TOKEN=$ROOT_TOKEN

  Option B — AppRole (recommended for production):
    VAULT_APPROLE_ROLE_ID=$ROLE_ID
    VAULT_APPROLE_SECRET_ID=$SECRET_ID

Then recreate mcp-approval2 so it picks up the new token:
    docker compose up -d --force-recreate mcp-approval2

BACKUP $OUT_FILE OFFLINE NOW.
────────────────────────────────────────────────────────────────────────
EOF
