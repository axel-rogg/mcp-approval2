#!/usr/bin/env bash
# Sync der SUB_MCP_TOKEN_* auf SECHS Stellen (beide V1 + V2 working).
#
# Strategie: dieselben random_password-Werte (aus V2-TF-State) wandern auf
#   - mcp-utils / mcp-gws / mcp-gcloud Worker als SERVICE_TOKEN (V2-seite)
#   - mcp-approval (V1-Hub) Worker als GATEWAY_UTILS / GATEWAY_GWS / GATEWAY_GCLOUD
#     (V1-seite — V1 liest secretRef=GATEWAY_<NAME> aus seinen Worker-Secrets)
#
# Damit funktionieren V1 (mcp.ai-toolhub.org) + V2 (mcp2.ai-toolhub.org) parallel.
# Wenn V1 spaeter retired wird, sind nur die mcp-utils/gws/gcloud-Tokens
# relevant.
#
# Voraussetzung:
#   - terraform/environments/privat/ ist applied (random_password generiert,
#     in Doppler/Fly verkabelt)
#   - wrangler CLI verfuegbar (oder via npx)
#   - CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID gesetzt (fuer wrangler)
#
# Usage:
#   bash scripts/sync-worker-tokens.sh                 # alle 6 puts
#   bash scripts/sync-worker-tokens.sh --v2-only       # nur 3 Worker (V1-break OK)
#   bash scripts/sync-worker-tokens.sh --v1-only       # nur V1-mcp-approval
#   bash scripts/sync-worker-tokens.sh --dry-run       # zeigt was passieren wuerde
#
# Effekt: alle 6 wrangler secret puts. Sofort wirksam (CF rolling-update).

set -euo pipefail

TF_DIR="terraform/environments/privat"
MODE="all"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --v2-only) MODE="v2" ;;
    --v1-only) MODE="v1" ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "Unbekannt: $arg"; exit 1 ;;
  esac
done

if [ ! -d "$TF_DIR" ]; then
  echo "FEHLER: muss aus mcp-approval2-Repo-Root laufen ($PWD passt nicht)."
  exit 1
fi

WRANGLER="${WRANGLER:-npx wrangler}"

if ! command -v doppler >/dev/null 2>&1; then
  echo "FEHLER: doppler CLI nicht gefunden."
  exit 1
fi

WORKERS=(utils gws gcloud)

put_secret() {
  local worker_name="$1"
  local secret_name="$2"
  local token="$3"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  [dry-run] would: $WRANGLER secret put $secret_name --name $worker_name (token=${#token} chars)"
    return
  fi
  printf '%s' "$token" | $WRANGLER secret put "$secret_name" --name "$worker_name"
}

for name in "${WORKERS[@]}"; do
  TF_OUT_NAME="sub_mcp_token_$name"
  echo ""
  echo "=== Token fuer '$name' aus TF lesen ==="
  TOKEN=$(cd "$TF_DIR" && bash ../../../scripts/doppler-run-terraform.sh output -raw "$TF_OUT_NAME" 2>/dev/null | tr -d '\n')
  if [ -z "$TOKEN" ]; then
    echo "  FEHLER: terraform output $TF_OUT_NAME leer — TF nicht applied?"
    continue
  fi
  echo "  Token: ${#TOKEN} chars"

  if [ "$MODE" = "all" ] || [ "$MODE" = "v2" ]; then
    # 2026-05-17: Worker env-var ist MCP_BEARER_TOKEN, nicht SERVICE_TOKEN
    # (Code-Inspection: src/mcp/server.ts vergleicht gegen env.MCP_BEARER_TOKEN).
    echo "  → V2: $WRANGLER secret put MCP_BEARER_TOKEN --name mcp-$name"
    put_secret "mcp-$name" "MCP_BEARER_TOKEN" "$TOKEN"
  fi

  if [ "$MODE" = "all" ] || [ "$MODE" = "v1" ]; then
    UPPER=$(echo "$name" | tr '[:lower:]' '[:upper:]')
    echo "  → V1: $WRANGLER secret put GATEWAY_$UPPER --name mcp-approval"
    put_secret "mcp-approval" "GATEWAY_$UPPER" "$TOKEN"
  fi
done

echo ""
echo "✓ Fertig."
if [ "$MODE" = "all" ]; then
  echo "  V1 (mcp.ai-toolhub.org) + V2 (mcp2.ai-toolhub.org) nutzen jetzt dieselben Tokens."
elif [ "$MODE" = "v2" ]; then
  echo "  Nur V2 gepushed. V1 wird ab JETZT 403 zu utils/gws/gcloud bekommen."
elif [ "$MODE" = "v1" ]; then
  echo "  Nur V1 gepushed. V2 noch nicht synchronisiert."
fi
echo ""
echo "Verify in V2 PWA: hart-refresh + Tools → Gateways neu entdecken."
