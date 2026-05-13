#!/usr/bin/env bash
# healthcheck.sh — status snapshot of all services. Exit non-zero on red.
#
# Checks:
#   - docker compose containers running
#   - postgres: pg_isready on both DBs
#   - openbao: bao status, initialized + unsealed
#   - mcp-approval2: GET /health returns 200
#   - mcp-knowledge2: GET /health returns 200
#   - caddy: container running (cert validity is checked via curl below)
#   - external reachability: curl https://${DOMAIN_*}/health (if .env present)

set -uo pipefail

cd "$(dirname "$0")"

FAIL=0
ok()   { echo "  ✓ $*"; }
warn() { echo "  ⚠ $*"; }
err()  { echo "  ✗ $*"; FAIL=1; }

echo "═══ mcp-approval2 healthcheck ═══"

# ── docker compose ────────────────────────────────────────────────────
echo ""
echo "Containers:"
RUNNING=$(docker compose ps --status running --format json 2>/dev/null | \
  jq -rs 'map(.Service) | sort | join(",")' 2>/dev/null || echo "")

for svc in postgres openbao mcp-approval2 mcp-knowledge2 caddy; do
  if echo ",$RUNNING," | grep -q ",$svc,"; then
    ok "$svc running"
  else
    err "$svc NOT running"
  fi
done

# ── postgres ──────────────────────────────────────────────────────────
echo ""
echo "Postgres:"
if docker compose exec -T postgres pg_isready -U app -d approval2 >/dev/null 2>&1; then
  ok "approval2 reachable"
else
  err "approval2 not reachable"
fi

if docker compose exec -T postgres pg_isready -U app -d knowledge2 >/dev/null 2>&1; then
  ok "knowledge2 reachable"
else
  err "knowledge2 not reachable"
fi

# ── openbao ───────────────────────────────────────────────────────────
echo ""
echo "OpenBao:"
STATUS=$(docker compose exec -T openbao bao status -format=json 2>/dev/null || echo '{}')
INIT=$(echo "$STATUS" | jq -r '.initialized // false' 2>/dev/null)
SEALED=$(echo "$STATUS" | jq -r '.sealed // true' 2>/dev/null)

if [[ "$INIT" == "true" ]]; then
  ok "initialized"
else
  warn "NOT initialized (run: bash vault-init.sh)"
fi

if [[ "$SEALED" == "false" ]]; then
  ok "unsealed"
elif [[ "$INIT" == "true" ]]; then
  err "sealed (run: docker compose exec openbao bao operator unseal <key>)"
fi

# ── mcp-approval2 + mcp-knowledge2 internal /health ──────────────────
echo ""
echo "App /health (internal):"
if docker compose exec -T mcp-approval2 \
   wget --quiet --tries=1 --spider http://localhost:8787/health 2>/dev/null; then
  ok "mcp-approval2 /health 200"
else
  err "mcp-approval2 /health failed"
fi

if docker compose exec -T mcp-knowledge2 \
   wget --quiet --tries=1 --spider http://localhost:8788/health 2>/dev/null; then
  ok "mcp-knowledge2 /health 200"
else
  err "mcp-knowledge2 /health failed"
fi

# ── External (TLS, DNS, Caddy chain) ─────────────────────────────────
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  source .env
  echo ""
  echo "External /health (TLS via Caddy):"
  for d in "${DOMAIN_MCP:-}" "${DOMAIN_KNOWLEDGE:-}"; do
    [[ -z "$d" ]] && continue
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$d/health" || echo "000")
    if [[ "$CODE" == "200" ]]; then
      ok "https://$d/health → 200"
    else
      err "https://$d/health → $CODE"
    fi
  done
fi

# ── Summary ───────────────────────────────────────────────────────────
echo ""
if (( FAIL == 0 )); then
  echo "═══ ALL GREEN ═══"
  exit 0
else
  echo "═══ FAILURES DETECTED ═══"
  exit 1
fi
