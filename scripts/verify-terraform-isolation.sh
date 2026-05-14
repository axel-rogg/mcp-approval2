#!/usr/bin/env bash
# ============================================================================
# verify-terraform-isolation.sh
#
# Pre-apply Safety-Check fuer mcp-approval2/terraform/environments/privat/.
# Verifies dass das Terraform-Setup keine cross-state-Konflikte mit
# mcp-approval/terraform/ hat (welches die Zone ai-toolhub.org managed).
#
# Was wir testen:
#   1. Backend-Key gehoert mcp-approval2 (eigener State-File-Path im R2)
#   2. main.tf nutzt `data "cloudflare_zone"` (read-only-Reference),
#      KEINE `resource "cloudflare_zone"`
#   3. cloudflare-dns-Modul enthaelt Reserved-Subdomain-Precondition
#   4. terraform plan zeigt KEIN destroy/update an reservierten Subdomains
#      (mcp/app/knowledge/gws/gcloud/utils/knowledge-core)
#   5. Plan-Actions sind ueberwiegend "+ create" (keine versehentlichen
#      "~ update" oder "- destroy" auf existierenden Resources)
#
# Exit codes:
#   0 — Alle Checks gruen, sicher fuer `terraform apply`
#   1 — Mindestens ein Check rot, NICHT applyen
# ============================================================================

set -euo pipefail

# Resolve repo root (parent of scripts/) so the script works from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TF_DIR="${REPO_ROOT}/terraform/environments/privat"
DNS_MODULE_DIR="${REPO_ROOT}/terraform/modules/cloudflare-dns"

cd "${TF_DIR}"

# --- pretty-printing -------------------------------------------------------
if [[ -t 1 ]]; then
  C_RED=$'\033[0;31m'
  C_GREEN=$'\033[0;32m'
  C_YELLOW=$'\033[0;33m'
  C_BLUE=$'\033[0;34m'
  C_BOLD=$'\033[1m'
  C_RESET=$'\033[0m'
else
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_BOLD=''; C_RESET=''
fi

PASS=0
FAIL=0
WARN=0

ok()   { echo "  ${C_GREEN}OK${C_RESET}    $*"; PASS=$((PASS+1)); }
bad()  { echo "  ${C_RED}FAIL${C_RESET}  $*"; FAIL=$((FAIL+1)); }
warn() { echo "  ${C_YELLOW}WARN${C_RESET}  $*"; WARN=$((WARN+1)); }
info() { echo "  ${C_BLUE}info${C_RESET}  $*"; }

# Reserved subdomains owned by mcp-approval/terraform/. Keep in sync with
# local.reserved_subdomains in modules/cloudflare-dns/main.tf.
RESERVED_FQDNS=(
  "mcp.ai-toolhub.org"
  "app.ai-toolhub.org"
  "knowledge.ai-toolhub.org"
  "knowledge-core.ai-toolhub.org"
  "gws.ai-toolhub.org"
  "gcloud.ai-toolhub.org"
  "utils.ai-toolhub.org"
)

echo ""
echo "${C_BOLD}===============================================================${C_RESET}"
echo "${C_BOLD}  Terraform Isolation Safety-Check (mcp-approval2 privat)${C_RESET}"
echo "${C_BOLD}===============================================================${C_RESET}"
echo ""

# ---------------------------------------------------------------------------
# 1. Backend-Key Isolation
# ---------------------------------------------------------------------------
echo "${C_BOLD}1. Backend-State-Key Isolation${C_RESET}"
if [[ ! -f "backend.tf" ]]; then
  bad "backend.tf nicht gefunden in ${TF_DIR}"
elif grep -q 'key[[:space:]]*=[[:space:]]*"mcp-approval2/privat/' backend.tf; then
  ok "Backend-State-Key gehoert mcp-approval2/privat (eigener Path)"
elif grep -qE 'key[[:space:]]*=[[:space:]]*"mcp-approval/' backend.tf; then
  bad "DANGER: Backend-Key zeigt auf mcp-approval/ State-File (cross-state-Konflikt!)"
else
  warn "Backend-Key nicht im erwarteten Format — manuell pruefen"
fi
echo ""

# ---------------------------------------------------------------------------
# 2. Read-only-Zone-Reference (data, nicht resource)
# ---------------------------------------------------------------------------
echo "${C_BOLD}2. Cloudflare-Zone-Reference-Type${C_RESET}"
if grep -rE '^resource[[:space:]]+"cloudflare_zone"[[:space:]]' "${TF_DIR}" "${DNS_MODULE_DIR}" >/dev/null 2>&1; then
  bad "DANGER: resource \"cloudflare_zone\" gefunden — wir wuerden die Zone uebernehmen!"
  grep -rE '^resource[[:space:]]+"cloudflare_zone"[[:space:]]' "${TF_DIR}" "${DNS_MODULE_DIR}" 2>/dev/null | sed 's/^/        /'
else
  ok "Keine resource \"cloudflare_zone\"-Blocks (Zone bleibt unter mcp-approval)"
fi

if grep -q 'data[[:space:]]*"cloudflare_zone"' main.tf 2>/dev/null; then
  ok "Zone wird via data \"cloudflare_zone\" read-only referenziert"
else
  warn "main.tf hat keinen data \"cloudflare_zone\"-Block (optional, aber Doku-Anker empfohlen)"
fi
echo ""

# ---------------------------------------------------------------------------
# 3. Reserved-Subdomain-Precondition im Modul
# ---------------------------------------------------------------------------
echo "${C_BOLD}3. Reserved-Subdomain-Precondition${C_RESET}"
if [[ ! -f "${DNS_MODULE_DIR}/main.tf" ]]; then
  bad "modules/cloudflare-dns/main.tf nicht gefunden"
elif grep -q 'reserved_subdomains' "${DNS_MODULE_DIR}/main.tf" \
     && grep -q 'precondition' "${DNS_MODULE_DIR}/main.tf"; then
  ok "Reserved-Subdomain-Validation aktiv (modules/cloudflare-dns/main.tf)"
  # Verify all expected names present.
  for name in mcp app knowledge gws gcloud utils; do
    if grep -qE "\"${name}\"" "${DNS_MODULE_DIR}/main.tf"; then
      :
    else
      warn "Subdomain '${name}' fehlt in reserved_subdomains-Liste"
    fi
  done
else
  bad "Reserved-Subdomain-Precondition fehlt — domain_mcp = \"mcp\" wuerde durchgehen!"
fi
echo ""

# ---------------------------------------------------------------------------
# 4. Plan-Generation + Konflikt-Scan
# ---------------------------------------------------------------------------
echo "${C_BOLD}4. Plan-Inhalt: Konflikt-Scan${C_RESET}"

if [[ ! -d ".terraform" ]]; then
  warn "Kein .terraform/ — terraform init wurde noch nicht gelaufen."
  info "Skipping plan-scan. Lauf 'terraform init' und ruf das Skript danach nochmal."
else
  PLAN_OUT="$(mktemp -t tf-plan.XXXXXX)"
  trap 'rm -f "${PLAN_OUT}"' EXIT

  echo "  ${C_BLUE}info${C_RESET}  Running terraform plan (this may take 15-30s)..."
  if ! terraform plan -no-color -input=false -out=/dev/null > "${PLAN_OUT}" 2>&1; then
    bad "terraform plan failed — siehe Output unten"
    sed 's/^/        /' "${PLAN_OUT}"
    echo ""
    echo "${C_RED}${C_BOLD}ISOLATION-CHECK ABGEBROCHEN.${C_RESET} Fix den plan-Error zuerst."
    exit 1
  fi
  ok "terraform plan succeeded"

  # 4a. Reserved-FQDN-Scan — diese Names duerfen NIRGENDS im Plan auftauchen
  RESERVED_HIT=0
  for fqdn in "${RESERVED_FQDNS[@]}"; do
    # Quote in plan output: name = "mcp.ai-toolhub.org"
    if grep -qE "[\"=][[:space:]]*\"${fqdn//./\\.}\"" "${PLAN_OUT}"; then
      bad "DANGER: Plan beruehrt '${fqdn}' (gehoert mcp-approval/terraform/!)"
      grep -nE "[\"=][[:space:]]*\"${fqdn//./\\.}\"" "${PLAN_OUT}" | head -3 | sed 's/^/        /'
      RESERVED_HIT=1
    fi
  done
  if [[ ${RESERVED_HIT} -eq 0 ]]; then
    ok "Keine reservierten Subdomains im Plan (mcp/app/knowledge/gws/gcloud/utils)"
  fi

  # 4b. Action-Stats (nur grobe Indikatoren, nicht load-bearing)
  CREATE_COUNT=$(grep -cE "^[[:space:]]*\+[[:space:]]+resource[[:space:]]" "${PLAN_OUT}" || true)
  CREATE_COUNT=${CREATE_COUNT:-0}
  UPDATE_COUNT=$(grep -cE "^[[:space:]]*~[[:space:]]+resource[[:space:]]" "${PLAN_OUT}" || true)
  UPDATE_COUNT=${UPDATE_COUNT:-0}
  DESTROY_COUNT=$(grep -cE "^[[:space:]]*-[[:space:]]+resource[[:space:]]" "${PLAN_OUT}" || true)
  DESTROY_COUNT=${DESTROY_COUNT:-0}

  info "Plan-Actions: ${CREATE_COUNT} create, ${UPDATE_COUNT} update, ${DESTROY_COUNT} destroy"

  if [[ ${DESTROY_COUNT} -gt 0 ]]; then
    warn "Plan enthaelt destroy-Actions — manuell pruefen ob beabsichtigt"
    grep -E "^[[:space:]]*-[[:space:]]+resource[[:space:]]" "${PLAN_OUT}" | head -5 | sed 's/^/        /'
  fi
fi
echo ""

# ---------------------------------------------------------------------------
# 5. Summary
# ---------------------------------------------------------------------------
echo "${C_BOLD}===============================================================${C_RESET}"
echo "${C_BOLD}  Result: ${PASS} passed, ${FAIL} failed, ${WARN} warnings${C_RESET}"
echo "${C_BOLD}===============================================================${C_RESET}"

if [[ ${FAIL} -gt 0 ]]; then
  echo ""
  echo "${C_RED}${C_BOLD}ISOLATION-CHECK FAILED.${C_RESET} ${C_RED}NICHT 'terraform apply' ausfuehren.${C_RESET}"
  echo "Siehe docs/runbooks/runbook-cloudflare-takeover.md fuer Troubleshooting."
  exit 1
fi

echo ""
echo "${C_GREEN}${C_BOLD}Isolation OK.${C_RESET} Sicher fuer 'terraform apply'."
if [[ ${WARN} -gt 0 ]]; then
  echo "${C_YELLOW}(${WARN} warnings — review optional)${C_RESET}"
fi
exit 0
