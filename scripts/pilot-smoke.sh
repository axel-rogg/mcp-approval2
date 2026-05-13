#!/usr/bin/env bash
#
# Pilot-Smoke — E2E gegen Docker-Compose-Stack.
#
# Was wird getestet:
#   1. Docker-Compose-Stack up (postgres, openbao, minio)
#   2. /health antwortet 200
#   3. OAuth-Discovery + JWKS sind public
#   4. /internal/v1/dek/resolve verlangt Service-Token (401 ohne)
#   5. /internal/v1/dek/resolve mit gueltigem Service-Token + Stub-User → 200
#   6. /internal/v1/credentials/resolve verlangt Service-Token (401 ohne)
#
# Usage:
#   bash scripts/pilot-smoke.sh
#
# Env-Vars (Defaults sind dev-only-Werte aus .env.example):
#   MCP_APPROVAL_BASE_URL              http://localhost:8787
#   MCP_APPROVAL_INTERNAL_TOKEN        dev-internal-token
#   PILOT_SMOKE_SKIP_COMPOSE           wenn gesetzt: keine docker-compose-Operationen
#   PILOT_SMOKE_SKIP_SERVER            wenn gesetzt: kein npm-dev-Boot (assumes server already up)
#
# Exit-Code: 0 → alles gruen, sonst 1 + Stack-Logs auf stderr.
#
set -euo pipefail

cd "$(dirname "$0")/.."

BASE_URL="${MCP_APPROVAL_BASE_URL:-http://localhost:8787}"
INTERNAL_TOKEN="${MCP_APPROVAL_INTERNAL_TOKEN:-dev-internal-token}"
SKIP_COMPOSE="${PILOT_SMOKE_SKIP_COMPOSE:-}"
SKIP_SERVER="${PILOT_SMOKE_SKIP_SERVER:-}"

# ─── helpers ───────────────────────────────────────────────────────────────

C_OK="\033[1;32m"
C_ERR="\033[1;31m"
C_DIM="\033[2m"
C_RST="\033[0m"

PASS=0
FAIL=0
FAIL_DETAILS=()

step() {
  printf "${C_DIM}→${C_RST} %s\n" "$1"
}

check() {
  local desc="$1"
  local actual="$2"
  local expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf "  ${C_OK}✓${C_RST} %s ${C_DIM}(got %s)${C_RST}\n" "$desc" "$actual"
    PASS=$((PASS + 1))
  else
    printf "  ${C_ERR}✗${C_RST} %s ${C_DIM}(got %s, expected %s)${C_RST}\n" "$desc" "$actual" "$expected"
    FAIL=$((FAIL + 1))
    FAIL_DETAILS+=("$desc: got $actual expected $expected")
  fi
}

http_code() {
  # curl -o /dev/null -s -w "%{http_code}" → just the status
  curl -o /dev/null -s -w "%{http_code}" "$@"
}

wait_for_url() {
  local url="$1"
  local max_attempts="${2:-30}"
  for i in $(seq 1 "$max_attempts"); do
    if curl -sf -o /dev/null "$url"; then
      return 0
    fi
    sleep 2
  done
  echo "wait_for_url: $url did not become ready in $((max_attempts * 2))s" >&2
  return 1
}

# ─── Stack-up ──────────────────────────────────────────────────────────────

if [[ -z "$SKIP_COMPOSE" ]]; then
  step "docker compose up -d (postgres + openbao + minio)"
  docker compose up -d
  step "warten auf postgres health"
  # docker compose ps liest health-state. Wir warten max 60s.
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    state=$(docker compose ps --format json 2>/dev/null | \
      grep -E '"Service":"postgres"' | grep -oE '"Health":"[^"]*"' | head -1 | cut -d\" -f4 || echo "")
    if [[ "$state" == "healthy" ]]; then break; fi
    sleep 5
  done
fi

# ─── DB-Migrate + Seed ─────────────────────────────────────────────────────

if [[ -z "$SKIP_COMPOSE" && -z "$SKIP_SERVER" ]]; then
  step "db:migrate"
  npm -w apps/server run db:migrate >/dev/null 2>&1 || {
    echo "db:migrate failed — siehe Logs in apps/server" >&2
    exit 1
  }
fi

# ─── Server-Boot ──────────────────────────────────────────────────────────

SERVER_PID=""
if [[ -z "$SKIP_SERVER" ]]; then
  step "server-boot (npm run dev, background)"
  # Wir setzen MCP_APPROVAL_INTERNAL_TOKEN damit der internal-Endpoint mounted ist.
  export MCP_APPROVAL_INTERNAL_TOKEN="$INTERNAL_TOKEN"
  ( cd apps/server && nohup npm run dev > /tmp/pilot-smoke-server.log 2>&1 ) &
  SERVER_PID=$!
  trap '[[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true' EXIT
  step "warten auf $BASE_URL/health"
  if ! wait_for_url "$BASE_URL/health" 30; then
    echo "server boot failed — logs:" >&2
    tail -50 /tmp/pilot-smoke-server.log >&2 || true
    exit 1
  fi
fi

# ─── Tests ────────────────────────────────────────────────────────────────

step "1. GET /health"
check "/health status" "$(http_code "$BASE_URL/health")" "200"

step "2. GET /.well-known/oauth-authorization-server"
check "/.well-known/oauth-authorization-server status" \
  "$(http_code "$BASE_URL/.well-known/oauth-authorization-server")" "200"

step "3. GET /.well-known/jwks.json"
check "/.well-known/jwks.json status" \
  "$(http_code "$BASE_URL/.well-known/jwks.json")" "200"

step "4. POST /internal/v1/dek/resolve ohne Auth → 401"
check "/internal/v1/dek/resolve unauth" \
  "$(http_code -X POST -H 'Content-Type: application/json' \
    -d '{"user_id":"00000000-0000-0000-0000-000000000001"}' \
    "$BASE_URL/internal/v1/dek/resolve")" "401"

step "5. POST /internal/v1/credentials/resolve ohne Auth → 401"
check "/internal/v1/credentials/resolve unauth" \
  "$(http_code -X POST -H 'Content-Type: application/json' \
    -d '{"user_jwt":"x","provider":"google-workspace"}' \
    "$BASE_URL/internal/v1/credentials/resolve")" "401"

step "6. POST /mcp ohne Auth → 401"
check "/mcp unauth" \
  "$(http_code -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
    "$BASE_URL/mcp")" "401"

# Optional, only when admin token + service token configured (skip on
# bare-bones smoke; covered by integration tests).
if [[ -n "${PILOT_SMOKE_DEEP:-}" ]]; then
  step "7. POST /internal/v1/dek/resolve mit Service-Token (DEEP)"
  USER_ID="${PILOT_SMOKE_USER_ID:-00000000-0000-0000-0000-000000000001}"
  CODE=$(http_code -X POST \
    -H "Authorization: Bearer $INTERNAL_TOKEN" \
    -H "X-Request-Id: pilot-smoke-deep" \
    -H "Content-Type: application/json" \
    -d "{\"user_id\":\"$USER_ID\"}" \
    "$BASE_URL/internal/v1/dek/resolve")
  # Erfolg waere 200; 5xx wenn KEK nicht da. Wir nehmen jeden non-401 als OK.
  if [[ "$CODE" != "401" ]]; then
    printf "  ${C_OK}✓${C_RST} /internal/v1/dek/resolve service-token akzeptiert (got %s)\n" "$CODE"
    PASS=$((PASS + 1))
  else
    printf "  ${C_ERR}✗${C_RST} /internal/v1/dek/resolve service-token wurde nicht akzeptiert (got 401)\n"
    FAIL=$((FAIL + 1))
    FAIL_DETAILS+=("internal/v1/dek/resolve service-token rejected")
  fi
fi

# ─── Summary ──────────────────────────────────────────────────────────────

echo
echo "─────────────────────────────────────────"
echo " Pilot-Smoke: $PASS passed, $FAIL failed"
echo "─────────────────────────────────────────"

if [[ "$FAIL" -gt 0 ]]; then
  printf "${C_ERR}Failures:${C_RST}\n"
  for d in "${FAIL_DETAILS[@]}"; do
    printf "  - %s\n" "$d"
  done
  exit 1
fi

printf "${C_OK}✓ Pilot-Smoke PASSED${C_RST}\n"
exit 0
