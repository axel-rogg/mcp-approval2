#!/usr/bin/env bash
# scripts/vault-shell.sh — Open a Vault/Bao CLI shell against the local OpenBao.
#
# Usage:
#   bash scripts/vault-shell.sh                          # interactive sh
#   bash scripts/vault-shell.sh bao read transit/keys/user-default
#   bash scripts/vault-shell.sh bao secrets list

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ -f .env ]]; then
  set -a; source .env; set +a
fi

VAULT_ADDR_INSIDE="http://127.0.0.1:8200"   # from inside the openbao container
VAULT_TOKEN="${VAULT_TOKEN:-root-dev-token-CHANGE-IN-PROD}"

if ! docker ps --format '{{.Names}}' | grep -q '^mcp-approval2-openbao$'; then
  echo "[vault-shell] openbao container not running. Run 'bash scripts/dev.sh' first." >&2
  exit 1
fi

# Run inside the openbao container — the 'bao' CLI is built-in.
if [[ $# -gt 0 ]]; then
  exec docker exec \
    -e VAULT_ADDR="$VAULT_ADDR_INSIDE" \
    -e BAO_ADDR="$VAULT_ADDR_INSIDE" \
    -e VAULT_TOKEN="$VAULT_TOKEN" \
    -e BAO_TOKEN="$VAULT_TOKEN" \
    mcp-approval2-openbao \
    "$@"
else
  exec docker exec -it \
    -e VAULT_ADDR="$VAULT_ADDR_INSIDE" \
    -e BAO_ADDR="$VAULT_ADDR_INSIDE" \
    -e VAULT_TOKEN="$VAULT_TOKEN" \
    -e BAO_TOKEN="$VAULT_TOKEN" \
    mcp-approval2-openbao \
    /bin/sh
fi
