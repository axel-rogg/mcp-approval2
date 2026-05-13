#!/usr/bin/env bash
# End-to-end smoke gegen lokales docker-compose-Setup (deploy/hetzner/).
#
# Voraussetzungen:
#   - deploy/hetzner/.env vorhanden mit gueltigen Werten
#   - docker compose -f deploy/hetzner/docker-compose.yml up -d gestartet
#   - migrations applied
#
# Tests:
#   1. health-endpoints aller Services (mcp-approval2, mcp-knowledge2)
#   2. OAuth-Discovery + JWKS
#   3. Internal-Endpoints (Service-Token-Gated)
#   4. Approval-Routes mit unauth -> 401
#   5. Caddy -> Backend Routing (optional via CHECK_CADDY=1)

set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE_FILE="deploy/hetzner/docker-compose.yml"

if [[ ! -f deploy/hetzner/.env ]]; then
  echo "ERROR: deploy/hetzner/.env missing — copy from .env.example and fill in." >&2
  exit 2
fi

# shellcheck disable=SC1091
set -a
source deploy/hetzner/.env
set +a

DOMAIN_MCP="${DOMAIN_MCP:-mcp2.ai-toolhub.org}"
DOMAIN_KNOWLEDGE="${DOMAIN_KNOWLEDGE:-knowledge2.ai-toolhub.org}"
INTERNAL_TOKEN="${MCP_APPROVAL_INTERNAL_TOKEN:?MCP_APPROVAL_INTERNAL_TOKEN missing in .env}"

# Test directly against container ports (umgeht Caddy, schneller)
APPROVAL_DIRECT="${APPROVAL_DIRECT:-http://localhost:8787}"
KNOWLEDGE_DIRECT="${KNOWLEDGE_DIRECT:-http://localhost:8788}"

PASS=0
FAIL=0

check() {
  local name=$1
  local url=$2
  local expected_status=${3:-200}
  local extra_args=${4:-}

  echo -n "  -> $name: $url ... "
  # shellcheck disable=SC2086
  status=$(eval curl -sS -o /dev/null -w "%{http_code}" "'$url'" $extra_args || echo "000")
  if [[ "$status" == "$expected_status" ]]; then
    echo "OK ($status)"
    PASS=$((PASS+1))
  else
    echo "FAIL (got $status, expected $expected_status)"
    FAIL=$((FAIL+1))
  fi
}

echo "==========================================="
echo "  Hetzner Local Smoke-Test"
echo "==========================================="

echo "-> docker compose status:"
docker compose -f "$COMPOSE_FILE" ps || true

echo ""
echo "-> Health Checks (direct, bypass Caddy):"
check "approval2 /health"  "$APPROVAL_DIRECT/health"
check "knowledge2 /health" "$KNOWLEDGE_DIRECT/health"

echo ""
echo "-> OAuth Discovery + JWKS:"
check "OAuth Discovery" "$APPROVAL_DIRECT/.well-known/oauth-authorization-server"
check "JWKS"            "$APPROVAL_DIRECT/.well-known/jwks.json"

echo ""
echo "-> Auth-Required Endpoints (401 expected):"
check "MCP w/o auth"          "$APPROVAL_DIRECT/mcp"             401  "-X POST"
check "Approvals w/o auth"    "$APPROVAL_DIRECT/v1/approvals"    401
check "Credentials w/o auth"  "$APPROVAL_DIRECT/v1/credentials"  401

echo ""
echo "-> Internal Endpoints (Service-Token-Gated):"
check "DEK w/o token" "$APPROVAL_DIRECT/internal/v1/dek/resolve" 401 "-X POST -H 'Content-Type: application/json' -d '{\"user_id\":\"00000000-0000-0000-0000-000000000000\"}'"
check "DEK w/ token"  "$APPROVAL_DIRECT/internal/v1/dek/resolve" 200 "-X POST -H 'Authorization: Bearer $INTERNAL_TOKEN' -H 'Content-Type: application/json' -H 'X-Request-Id: smoke-$(date +%s)' -d '{\"user_id\":\"00000000-0000-0000-0000-000000000001\"}'"

if [[ "${CHECK_CADDY:-0}" == "1" ]]; then
  echo ""
  echo "-> Caddy -> Backend Routing (host-header):"
  check "approval2 via Caddy"  "http://localhost/health" 200 "-H 'Host: $DOMAIN_MCP'"
  check "knowledge2 via Caddy" "http://localhost/health" 200 "-H 'Host: $DOMAIN_KNOWLEDGE'"
fi

echo ""
echo "==========================================="
echo "  Result: $PASS passed, $FAIL failed"
echo "==========================================="

[[ $FAIL -eq 0 ]] || exit 1
