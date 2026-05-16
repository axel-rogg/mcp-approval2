#!/usr/bin/env bash
# Smoke gegen Fly.io production-Deploy via public HTTPS (Fly auto-TLS).
#
# Erbt das Layer-2-Pattern von pilot-smoke-hetzner-remote.sh (8 Checks,
# nur Read-Only-Endpoints + Auth-Gate-Verifikation). Erzeugt KEINE
# Approvals (User-Decision 2026-05-15, siehe scripts/smoke-prod.sh in
# mcp-approval v1).
#
# Env:
#   SMOKE_DOMAIN_MCP            = mcp2.ai-toolhub.org (default)
#                                 Fallback: mcp-approval2.fly.dev (wenn
#                                 Custom-Domain noch nicht via `fly certs add`
#                                 aktiv ist — Operator setzt dann via
#                                 SMOKE_DOMAIN_MCP=mcp-approval2.fly.dev)
#   SMOKE_DOMAIN_KNOWLEDGE      = knowledge2.ai-toolhub.org (default)
#                                 Fallback: mcp-knowledge2.fly.dev
#   MCP_APPROVAL_INTERNAL_TOKEN = service-token (required für /internal/v1/dek/*
#                                 Auth-Gate-Test — Smoke prüft NUR die 401-Antwort
#                                 ohne Token, sendet den Token NIE)
#   THROTTLE_MS                 = 200 (default) — gegen CF-Rate-Limit wenn
#                                 Custom-Domain CF-proxied ist (sollte sie
#                                 nicht sein wegen WebAuthn-Origin, aber
#                                 Safety-Throttle bleibt)
#
# Architektur-Wahrheit: docs/privat.md (Fly.io-privat-Mode-Pfad).

set -euo pipefail

DOMAIN_MCP="${SMOKE_DOMAIN_MCP:-mcp2.ai-toolhub.org}"
DOMAIN_KNOWLEDGE="${SMOKE_DOMAIN_KNOWLEDGE:-knowledge2.ai-toolhub.org}"
INTERNAL_TOKEN="${MCP_APPROVAL_INTERNAL_TOKEN:?MCP_APPROVAL_INTERNAL_TOKEN missing}"
THROTTLE_MS="${THROTTLE_MS:-200}"

PASS=0
FAIL=0

throttle() {
  if command -v bc >/dev/null 2>&1; then
    sleep "$(echo "scale=3; $THROTTLE_MS/1000" | bc)"
  else
    # bc-frei fallback: ganzzahlige Sekunden
    sleep "$(( THROTTLE_MS / 1000 ))"
  fi
}

check() {
  local name=$1
  local url=$2
  local expected_status=${3:-200}
  local extra_args=${4:-}

  throttle

  echo -n "  -> $name: $url ... "
  # shellcheck disable=SC2086
  status=$(eval curl -sSL -o /dev/null -w "%{http_code}" "'$url'" $extra_args || echo "000")
  if [[ "$status" == "$expected_status" ]]; then
    echo "OK ($status)"
    PASS=$((PASS+1))
  else
    echo "FAIL (got $status, expected $expected_status)"
    FAIL=$((FAIL+1))
  fi
}

echo "==========================================="
echo "  Fly.io Production Smoke (public HTTPS)"
echo "==========================================="

echo ""
echo "-> https://$DOMAIN_MCP"
check "health"                 "https://$DOMAIN_MCP/health"
check "OAuth Discovery"        "https://$DOMAIN_MCP/.well-known/oauth-authorization-server"
check "JWKS"                   "https://$DOMAIN_MCP/.well-known/jwks.json"
check "MCP w/o auth"           "https://$DOMAIN_MCP/mcp"            401 "-X POST"
check "approvals w/o auth"     "https://$DOMAIN_MCP/v1/approvals"   401
check "credentials w/o auth"   "https://$DOMAIN_MCP/v1/credentials" 401
check "DEK w/o token"          "https://$DOMAIN_MCP/internal/v1/dek/resolve" 401 "-X POST -H 'Content-Type: application/json' -d '{}'"

echo ""
echo "-> https://$DOMAIN_KNOWLEDGE"
check "knowledge2 health" "https://$DOMAIN_KNOWLEDGE/health"

echo ""
echo "==========================================="
echo "  Result: $PASS passed, $FAIL failed"
echo "==========================================="

[[ $FAIL -eq 0 ]] || exit 1
