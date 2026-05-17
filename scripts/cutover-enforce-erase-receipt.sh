#!/usr/bin/env bash
# cutover-enforce-erase-receipt.sh — Cutover-Window-Step T+40min:
#
# Flippt REQUIRE_ERASE_RECEIPT in mcp-knowledge2 / privat von "false" auf
# "true". Ab dann verlangt KC2 bei jeder erase-user-Operation einen
# x-erase-receipt-JWS-Header (SEC-K-016 + MUSS-§4.1.2 enforced).
#
# Vorab: approval2 + knowledge2 muessen redeployed sein mit dem heutigen
# Code (knowledge2 commits 19b60f8 + 38b3ec1 + d4a0b34, approval2 9c4813f).
# Sonst kann approval2 den Receipt nicht signen und KC2 weist sie ab.
#
# Reihenfolge im Cutover-Window:
#   T+0    Doppler-Tokens via TF gesetzt (geschehen)
#   T+15   beide Services Fly-deployed
#   T+30   Smoke: Login + Storage-Tab in PWA klappt
#   T+40   ← DIESES SKRIPT
#   T+45   Smoke: erase-Test-User → audit zeigt receipt-verified=true
#
# Rollback wenn was schiefgeht:
#   bash scripts/cutover-enforce-erase-receipt.sh --rollback
# oder:
#   terraform apply -var=require_erase_receipt=false \
#     -target=doppler_secret.knowledge2_require_erase_receipt_privat

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MODE="enforce"
if [[ "${1:-}" == "--rollback" ]]; then
  MODE="rollback"
fi

if [[ "$MODE" == "enforce" ]]; then
  TARGET_VALUE="true"
  echo "▶ Flippe REQUIRE_ERASE_RECEIPT → true (SEC-K-016 enforced)"
else
  TARGET_VALUE="false"
  echo "▶ Rollback: REQUIRE_ERASE_RECEIPT → false (legacy-Pfad)"
fi

PLAN_OUT="/tmp/cutover-erase-receipt-${MODE}.tfplan"

echo ""
echo "─── TF plan ────────────────────────────────────────────────────────"
bash scripts/doppler-run-terraform.sh plan \
  -var="require_erase_receipt=${TARGET_VALUE}" \
  -target=doppler_secret.knowledge2_require_erase_receipt_privat \
  -out="$PLAN_OUT"

echo ""
echo "─── Confirm ────────────────────────────────────────────────────────"
read -r -p "Apply ausfuehren? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Abgebrochen. Plan-File bleibt unter $PLAN_OUT, falls du es danach apply'st."
  exit 0
fi

echo ""
echo "─── TF apply ───────────────────────────────────────────────────────"
bash scripts/doppler-run-terraform.sh apply "$PLAN_OUT"

echo ""
echo "─── Verify ─────────────────────────────────────────────────────────"
echo "Doppler-Wert pruefen:"
echo "  doppler secrets get REQUIRE_ERASE_RECEIPT --project mcp-knowledge2 --config privat --plain"
echo ""
echo "Fly liest Doppler-Werte NICHT auto-sync. Damit der Flag wirksam wird,"
echo "muss KC2 einmal restarten:"
echo "  fly machine restart -a mcp-knowledge2"
echo ""
echo "Smoke (sollte erase-without-receipt jetzt mit 403 ablehnen):"
echo "  curl -X POST https://mcp-knowledge2.flycast/v1/internal/erase-user \\"
echo "    -H 'authorization: Bearer <SERVICE_TOKEN_ERASE>' \\"
echo "    -H 'content-type: application/json' \\"
echo "    -d '{\"user_id\":\"...\",\"confirmation_token\":\"...\"}'"
echo ""
echo "✓ Done."
