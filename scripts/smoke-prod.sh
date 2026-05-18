#!/usr/bin/env bash
# Smoke-Prod — read-only Health + Auth-Gate-Checks gegen Fly.io-Production.
#
# Erzeugt KEINE Approvals, schreibt KEINE Daten. Nur:
#   - Public health endpoints (no auth)
#   - OAuth-Discovery + JWKS
#   - Auth-Gate-Verifikation (401 ohne Bearer auf protected routes)
#   - Phase-2: internal/v1/rewrap-* serviceTokenGuard verifiziert
#
# KC2 ist post-Lockdown 2026-05-17 internal-only — direkter Public-Smoke
# nicht moeglich; ueber approval2-Proxy /admin/kc-proxy/* einigermassen.
#
# Env:
#   SMOKE_BASE                  = https://mcp2.ai-toolhub.org (default)
#   SMOKE_PWA                   = https://app2.ai-toolhub.org (default)
#   THROTTLE_MS                 = 150 (default) — CF-Rate-Limit-Safety
#   MAX_RETRIES                 = 3 (default) — exponential backoff fuer 429/5xx
#
# Exit-Code: 0 = all green, 1 = mindestens ein Fail.
#
# Inspired by mcp-approval v1 scripts/smoke-prod.sh + Lessons-Learned aus
# CF-Rate-Limit-Sprint (Throttle + Retry pflicht).

set -uo pipefail

BASE="${SMOKE_BASE:-https://mcp2.ai-toolhub.org}"
PWA="${SMOKE_PWA:-https://app2.ai-toolhub.org}"
THROTTLE_MS="${THROTTLE_MS:-150}"
MAX_RETRIES="${MAX_RETRIES:-3}"

PASS=0
FAIL=0
SKIP=0
FAILED_TESTS=()

# ─── helpers ──────────────────────────────────────────────────────────────

throttle() {
  if command -v bc >/dev/null 2>&1; then
    sleep "$(echo "scale=3; $THROTTLE_MS/1000" | bc)"
  else
    sleep "$(( THROTTLE_MS / 1000 ))"
  fi
}

# request_with_retry <url> [curl-args...]: echo "<status> <body-size>", retry on 429/503
request_with_retry() {
  local url=$1
  shift
  local attempt=0
  local status="000"
  local body_size="0"
  while [ "$attempt" -lt "$MAX_RETRIES" ]; do
    throttle
    local response_file
    response_file=$(mktemp)
    # shellcheck disable=SC2086
    status=$(curl -sSL -o "$response_file" -w "%{http_code}" "$url" "$@" 2>/dev/null || echo "000")
    body_size=$(wc -c < "$response_file" | tr -d ' ')
    rm -f "$response_file"
    case "$status" in
      429|503|502)
        attempt=$((attempt + 1))
        sleep $(( attempt * 2 ))
        continue
        ;;
      *)
        break
        ;;
    esac
  done
  echo "$status $body_size"
}

check() {
  local name=$1
  local url=$2
  local expected=$3
  shift 3
  local result
  result=$(request_with_retry "$url" "$@")
  local status
  status=$(echo "$result" | awk '{print $1}')

  printf "  %-60s " "$name"
  if [[ "$status" == "$expected" ]]; then
    echo "OK ($status)"
    PASS=$((PASS+1))
  else
    echo "FAIL (got $status, expected $expected)"
    FAIL=$((FAIL+1))
    FAILED_TESTS+=("$name: got $status, expected $expected")
  fi
}

check_contains() {
  local name=$1
  local url=$2
  local needle=$3
  shift 3
  throttle
  local body
  # shellcheck disable=SC2086
  body=$(curl -sSL "$url" "$@" 2>/dev/null || echo "")
  printf "  %-60s " "$name"
  if [[ "$body" == *"$needle"* ]]; then
    echo "OK"
    PASS=$((PASS+1))
  else
    echo "FAIL (no '$needle' in body)"
    FAIL=$((FAIL+1))
    FAILED_TESTS+=("$name: missing '$needle'")
  fi
}

# ─── tests ────────────────────────────────────────────────────────────────

echo "==========================================="
echo "  smoke-prod — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "  approval2: $BASE"
echo "  pwa:       $PWA"
echo "==========================================="
echo

echo "── 1. Health ─────────────────────────────"
check "approval2 /health"                "$BASE/health"                                200
check "PWA root reachable"                "$PWA/"                                       200
echo

echo "── 2. OAuth-Discovery + JWKS ─────────────"
check "/.well-known/oauth-authorization-server" "$BASE/.well-known/oauth-authorization-server" 200
check "/.well-known/jwks.json"                "$BASE/.well-known/jwks.json"                  200
check_contains "JWKS has keys"                "$BASE/.well-known/jwks.json"                  "\"keys\""
echo

echo "── 3. Auth-Gates (Authentifizierung erforderlich) ──"
check "/mcp ohne Bearer"                   "$BASE/mcp"                                   401  -X POST
check "/v1/approvals ohne Bearer"           "$BASE/v1/approvals"                          401
check "/v1/credentials ohne Bearer"         "$BASE/v1/credentials"                        401
check "/v1/admin ohne Bearer"               "$BASE/v1/admin"                              401
echo

echo "── 4. Internal-Routes Service-Token-Gate ──"
check "/internal/v1/dek/resolve ohne Token"  "$BASE/internal/v1/dek/resolve"               401 -X POST -H 'Content-Type: application/json' -d '{}'
check "/internal/v1/credentials/resolve ohne Token" "$BASE/internal/v1/credentials/resolve" 401 -X POST -H 'Content-Type: application/json' -d '{}'
check "/internal/v1/cron ohne Token"         "$BASE/internal/v1/cron"                       401
echo

echo "── 5. Phase-2 Routes ─────────────────────"
check "/internal/v1/rewrap-tick ohne Token (P2-7)" "$BASE/internal/v1/rewrap-tick" 401 -X POST -H 'Content-Type: application/json' -d '{}'
check "/internal/v1/rewrap-jobs ohne Token (P2-7)" "$BASE/internal/v1/rewrap-jobs" 401
echo

echo "── 6. Bidirectional Invite (P2-6 v2) ───"
# Admin-Routes-Gate; tatsaechliche Invite-Creation braucht Session-Cookie
check "/admin/invites ohne Auth (P2-6)"      "$BASE/admin/invites"                          401 -X POST -H 'Content-Type: application/json' -d '{"email":"smoke@test.local"}'
echo

echo "── 7. Static-Assets der PWA ──────────────"
check "PWA service-worker"                   "$PWA/sw.js"                                   200
check_contains "PWA index.html ist HTML"             "$PWA/" "<!DOCTYPE html>"
echo

echo "==========================================="
echo "  PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
echo "==========================================="

if [[ $FAIL -gt 0 ]]; then
  echo
  echo "Failed tests:"
  for t in "${FAILED_TESTS[@]}"; do
    echo "  - $t"
  done
  exit 1
fi
