#!/usr/bin/env bash
# Smoke gegen production VM via public HTTPS (Caddy + Lets-Encrypt).
#
# Env:
#   SMOKE_DOMAIN_MCP            = mcp2.ai-toolhub.org (default)
#   SMOKE_DOMAIN_KNOWLEDGE      = knowledge2.ai-toolhub.org (default)
#   MCP_APPROVAL_INTERNAL_TOKEN = service-token (required)
#   THROTTLE_MS                 = 200 (default) — gegen Cloudflare-1015 wenn proxied

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
echo "  Hetzner Remote Smoke (public HTTPS)"
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
