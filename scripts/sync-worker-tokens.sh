#!/usr/bin/env bash
# Sync der V2 SUB_MCP_TOKEN_* auf die 3 CF-Worker-Repos (mcp-utils/gws/gcloud).
#
# Voraussetzung: terraform/environments/privat/ ist applied (random_password
# resources existieren). Du brauchst:
#   - terraform CLI mit dem privat-State (Doppler wrap macht das)
#   - wrangler CLI authenticated als CF-Account-Owner
#   - Die 3 Worker-Repos sind als Git-Klone unter /workspaces/{mcp-utils,mcp-gws,mcp-gcloud}
#     ODER du fuehrst dieses Skript aus jedem Repo separat aus
#
# Usage:
#   bash scripts/sync-worker-tokens.sh         # alle 3 Worker
#   bash scripts/sync-worker-tokens.sh utils   # nur utils
#
# Effekt:
#   - terraform output -raw sub_mcp_token_<name> → wrangler secret put SERVICE_TOKEN --name mcp-<name>
#   - Worker uebernimmt den Token sofort (CF rolling-update)

set -euo pipefail

TF_DIR="terraform/environments/privat"
WORKERS=("${1:-utils gws gcloud}")

if [ ! -d "$TF_DIR" ]; then
  echo "FEHLER: muss aus mcp-approval2-Repo-Root laufen ($PWD passt nicht)."
  exit 1
fi

if ! command -v wrangler >/dev/null 2>&1; then
  echo "FEHLER: wrangler CLI nicht gefunden. npm i -g wrangler"
  exit 1
fi

for name in $WORKERS; do
  echo ""
  echo "=== Sync SUB_MCP_TOKEN_${name^^} → wrangler secret put SERVICE_TOKEN --name mcp-$name ==="
  TOKEN=$(cd "$TF_DIR" && bash ../../../scripts/doppler-run-terraform.sh output -raw "sub_mcp_token_$name" 2>/dev/null | tr -d '\n')
  if [ -z "$TOKEN" ]; then
    echo "  FEHLER: terraform output sub_mcp_token_$name leer"
    continue
  fi
  echo "  Token-Length: ${#TOKEN} chars"
  # wrangler secret put nimmt stdin
  printf '%s' "$TOKEN" | wrangler secret put SERVICE_TOKEN --name "mcp-$name"
  echo "  ✓ mcp-$name SERVICE_TOKEN gesetzt."
done

echo ""
echo "Fertig. V2-Doppler-Werte + Worker-Side sind jetzt synchron."
echo "Verify: in V2 PWA → Tools → Gateways neu entdecken → utils/gws/gcloud sollten Tools liefern."
