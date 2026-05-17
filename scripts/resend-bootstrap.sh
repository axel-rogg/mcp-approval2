#!/usr/bin/env bash
# resend-bootstrap.sh — One-Shot Resend Domain + API-Key Setup
#
# Was es macht (alles via Resend REST-API):
#   1. POST /domains → ai-toolhub.org anlegen, Response enthaelt 3 DNS-Records
#   2. DNS-Records in terraform.tfvars schreiben damit cloudflare-resend.tf
#      sie als Variables aufnimmt
#   3. POST /api-keys → "mcp-approval2-prod" mit Sending-only scope erzeugen
#   4. RESEND_API_KEY + EMAIL_PROVIDER=resend in Doppler setzen
#
# Was du vorher manuell brauchst (5 min, ein-malig):
#   - Account auf resend.com/signup mit deiner Operator-Email
#   - Im Dashboard → API Keys → Create API Key mit Permission "Full access"
#     (brauchen wir damit das Script Domains UND API-Keys erstellen darf)
#   - Diesen Bootstrap-Key als RESEND_BOOTSTRAP_TOKEN exportieren:
#       export RESEND_BOOTSTRAP_TOKEN=re_...
#     (Idee: nach diesem Script den Bootstrap-Key in Resend revoken — die
#     Production-API hat nur Sending-Scope, sicherer.)
#
# Aufruf:
#   export RESEND_BOOTSTRAP_TOKEN=re_xxx
#   export DOPPLER_TOKEN=$(grep ^DOPPLER_TOKEN= .dev.vars | cut -d= -f2-)
#   bash scripts/resend-bootstrap.sh
#
# Nach dem Script:
#   bash scripts/doppler-run-terraform.sh apply -target=cloudflare_dns_record.resend_dkim ...
#   (Records sind in CF in < 1 min)
#   Im Resend-Dashboard → Domain → Verify Records → sollte direkt gruen sein

set -euo pipefail

DOMAIN="${RESEND_DOMAIN:-ai-toolhub.org}"
REGION="${RESEND_REGION:-eu-west-1}"
DOPPLER_PROJECT="${DOPPLER_PROJECT:-mcp-approval2}"
DOPPLER_CONFIG="${DOPPLER_CONFIG:-fly}"
TFVARS_FILE="${TFVARS_FILE:-terraform/environments/privat/resend.auto.tfvars}"

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

if [ -z "${RESEND_BOOTSTRAP_TOKEN:-}" ]; then
  echo "ERROR: RESEND_BOOTSTRAP_TOKEN nicht gesetzt." >&2
  echo "" >&2
  echo "Setup-Sequenz:" >&2
  echo "  1. resend.com/signup → Operator-Email" >&2
  echo "  2. Dashboard → API Keys → Create API Key (Permission: Full access)" >&2
  echo "  3. export RESEND_BOOTSTRAP_TOKEN=re_<dein-key>" >&2
  echo "  4. bash scripts/resend-bootstrap.sh" >&2
  exit 1
fi

if [ -z "${DOPPLER_TOKEN:-}" ]; then
  echo "ERROR: DOPPLER_TOKEN nicht gesetzt." >&2
  echo "  export DOPPLER_TOKEN=\$(grep ^DOPPLER_TOKEN= .dev.vars | cut -d= -f2-)" >&2
  exit 1
fi

for cmd in curl jq doppler; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: '$cmd' nicht installiert." >&2
    exit 1
  fi
done

echo "→ Domain:  $DOMAIN (region: $REGION)"
echo "→ Doppler: $DOPPLER_PROJECT/$DOPPLER_CONFIG"
echo

# ---------------------------------------------------------------------------
# Step 1: Domain anlegen (oder bestehende abrufen)
# ---------------------------------------------------------------------------

echo "==> 1/4 Domain anlegen bei Resend..."

# Resend lehnt double-create ab — wir versuchen Create, fallen auf List-by-name
# zurueck wenn 409/422.
CREATE_RESP=$(curl -sS -X POST https://api.resend.com/domains \
  -H "Authorization: Bearer $RESEND_BOOTSTRAP_TOKEN" \
  -H "content-type: application/json" \
  -d "{\"name\":\"$DOMAIN\",\"region\":\"$REGION\"}" \
  || true)

DOMAIN_ID=$(echo "$CREATE_RESP" | jq -r '.id // empty')

if [ -z "$DOMAIN_ID" ]; then
  echo "  Create returned no id — vermutlich bereits vorhanden. Suche per List..."
  LIST_RESP=$(curl -sS https://api.resend.com/domains \
    -H "Authorization: Bearer $RESEND_BOOTSTRAP_TOKEN")
  DOMAIN_ID=$(echo "$LIST_RESP" | jq -r ".data[] | select(.name == \"$DOMAIN\") | .id" | head -1)
  if [ -z "$DOMAIN_ID" ]; then
    echo "  ERROR: konnte Domain weder erstellen noch finden. Response:" >&2
    echo "$CREATE_RESP" | jq . >&2 || echo "$CREATE_RESP" >&2
    exit 1
  fi
  echo "  Gefunden: $DOMAIN_ID"
  # Records sind nur in CREATE-Response; bei bestehender Domain holen via GET
  GET_RESP=$(curl -sS "https://api.resend.com/domains/$DOMAIN_ID" \
    -H "Authorization: Bearer $RESEND_BOOTSTRAP_TOKEN")
  RECORDS_JSON=$(echo "$GET_RESP" | jq '.records // []')
else
  echo "  Erstellt: $DOMAIN_ID"
  RECORDS_JSON=$(echo "$CREATE_RESP" | jq '.records // []')
fi

if [ "$(echo "$RECORDS_JSON" | jq 'length')" = "0" ]; then
  echo "  ERROR: Resend hat keine DNS-Records zurueckgegeben." >&2
  exit 1
fi

echo "  Records erhalten: $(echo "$RECORDS_JSON" | jq 'length')"

# ---------------------------------------------------------------------------
# Step 2: Records in tfvars schreiben
# ---------------------------------------------------------------------------

echo
echo "==> 2/4 DNS-Records in $TFVARS_FILE schreiben..."

# Resend liefert Records als Array von:
#   { record: "SPF"|"DKIM"|"DMARC", name: "...", value: "...", type: "TXT"|"CNAME"|"MX", priority: number? }
# Wir extrahieren sie und schreiben sie als TF-Variables.

DKIM_NAME=$(echo "$RECORDS_JSON" | jq -r '.[] | select(.record == "DKIM" or .type == "CNAME") | .name' | head -1)
DKIM_VALUE=$(echo "$RECORDS_JSON" | jq -r '.[] | select(.record == "DKIM" or .type == "CNAME") | .value' | head -1)
DKIM_TYPE=$(echo "$RECORDS_JSON" | jq -r '.[] | select(.record == "DKIM" or .type == "CNAME") | .type' | head -1)
SPF_NAME=$(echo "$RECORDS_JSON" | jq -r '.[] | select(.record == "SPF" and .type == "TXT") | .name' | head -1)
SPF_VALUE=$(echo "$RECORDS_JSON" | jq -r '.[] | select(.record == "SPF" and .type == "TXT") | .value' | head -1)
MX_NAME=$(echo "$RECORDS_JSON" | jq -r '.[] | select(.type == "MX") | .name' | head -1)
MX_VALUE=$(echo "$RECORDS_JSON" | jq -r '.[] | select(.type == "MX") | .value' | head -1)
MX_PRIORITY=$(echo "$RECORDS_JSON" | jq -r '.[] | select(.type == "MX") | .priority // 10' | head -1)

cat > "$TFVARS_FILE" <<EOF
# Auto-generated by scripts/resend-bootstrap.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Quelle: Resend POST /domains response fuer $DOMAIN
# NICHT manuell editieren — re-run bootstrap-Script.

enable_resend_dns       = true
resend_dkim_record_name = "$DKIM_NAME"
resend_dkim_record_value = "$DKIM_VALUE"
resend_dkim_record_type = "$DKIM_TYPE"
resend_spf_record_name  = "$SPF_NAME"
resend_spf_record_value = "$SPF_VALUE"
resend_mx_record_name   = "$MX_NAME"
resend_mx_record_value  = "$MX_VALUE"
resend_mx_record_priority = $MX_PRIORITY
EOF

echo "  Geschrieben:"
echo "    DKIM: $DKIM_TYPE $DKIM_NAME → $DKIM_VALUE"
echo "    SPF:  TXT  $SPF_NAME → $SPF_VALUE"
echo "    MX:   $MX_PRIORITY  $MX_NAME → $MX_VALUE"

# ---------------------------------------------------------------------------
# Step 3: Production API-Key erzeugen (Sending-only)
# ---------------------------------------------------------------------------

echo
echo "==> 3/4 Production API-Key 'mcp-approval2-prod' anlegen..."

KEY_RESP=$(curl -sS -X POST https://api.resend.com/api-keys \
  -H "Authorization: Bearer $RESEND_BOOTSTRAP_TOKEN" \
  -H "content-type: application/json" \
  -d '{"name":"mcp-approval2-prod","permission":"sending_access"}')

PROD_KEY=$(echo "$KEY_RESP" | jq -r '.token // empty')

if [ -z "$PROD_KEY" ]; then
  echo "  ERROR: konnte Production-Key nicht erzeugen." >&2
  echo "$KEY_RESP" | jq . >&2 || echo "$KEY_RESP" >&2
  exit 1
fi

echo "  Generiert (token wird NICHT geprintet, geht direkt nach Doppler)"

# ---------------------------------------------------------------------------
# Step 4: Doppler-Secrets setzen
# ---------------------------------------------------------------------------

echo
echo "==> 4/4 Doppler-Secrets setzen..."

doppler secrets set \
  RESEND_API_KEY="$PROD_KEY" \
  EMAIL_PROVIDER="resend" \
  --project "$DOPPLER_PROJECT" \
  --config "$DOPPLER_CONFIG" \
  --silent

echo "  RESEND_API_KEY + EMAIL_PROVIDER=resend in Doppler $DOPPLER_PROJECT/$DOPPLER_CONFIG"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

echo
echo "========================================================================"
echo " ✓ Resend-Bootstrap abgeschlossen"
echo "========================================================================"
echo
echo " Nächste Schritte:"
echo
echo "  1. TF-Apply (legt die 3 CF-DNS-Records an):"
echo "     bash scripts/doppler-run-terraform.sh apply \\"
echo "       -target=cloudflare_dns_record.resend_dkim \\"
echo "       -target=cloudflare_dns_record.resend_send_mx \\"
echo "       -target=cloudflare_dns_record.resend_send_spf"
echo
echo "  2. Fly-Push der neuen Secrets + Redeploy:"
echo "     RESEND_API_KEY=\$(doppler secrets get RESEND_API_KEY \\"
echo "       --plain --project $DOPPLER_PROJECT --config $DOPPLER_CONFIG)"
echo "     fly secrets set -a mcp-approval2 \\"
echo "       EMAIL_PROVIDER=resend RESEND_API_KEY=\"\$RESEND_API_KEY\""
echo
echo "  3. Im Resend-Dashboard → Domain $DOMAIN → 'Verify Records' klicken"
echo "     (sollte direkt gruen — CF DNS-Propagation < 1 min)"
echo
echo "  4. Smoke-Test: Im PWA Admin-Tab → Invites → echte Email eingeben →"
echo "     POST /admin/invites sollte status='sent' returnen (statt 'logged')."
echo
echo "  5. Bootstrap-Key in Resend revoken (Production nutzt jetzt 'sending_access'-key)"
echo
