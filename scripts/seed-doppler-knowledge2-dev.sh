#!/usr/bin/env bash
# ============================================================================
# Seed Doppler dev-Config fuer mcp-knowledge2 mit generierten Crypto-Keys
# ============================================================================
#
# Was DIESES Script tut:
#   - Generiert 3 frische Crypto-Keys via openssl rand:
#       * SERVICE_TOKEN        (32 bytes → hex, fuer Cross-Service-Auth)
#       * KMS_MASTER_KEY_B64   (32 bytes → base64, fuer hkdf_local KMS)
#       * BACKUP_MASTER_KEY    (32 bytes → base64, fuer Backup-Encryption)
#   - Schreibt sie in Doppler-Project mcp-knowledge2, Config dev (silent —
#     Werte werden NICHT auf stdout/stderr ausgegeben)
#
# Was DIESES Script NICHT tut:
#   - Werte in privat-Config setzen (das ist Produktion, eigene Keys)
#   - Google OAuth Client / Secret (manuell aus Google Cloud Console)
#   - Vertex AI Service-Account (manuell)
#   - DB-Passwords (entweder dev-defaults via Terraform schon gesetzt,
#     oder VM-setup.sh generiert sie fuer privat)
#
# Voraussetzung:
#   - doppler-cli installiert + DOPPLER_TOKEN exportiert (workplace:admin)
#   - openssl installiert
#   - Doppler-Project mcp-knowledge2 + Config dev existieren bereits
#     (via `terraform apply` auf knowledge2-doppler.tf)
#
# Usage:
#   bash scripts/seed-doppler-knowledge2-dev.sh
#
# Idempotenz:
#   Re-run ueberschreibt die 3 Werte mit neuen frischen Keys. Wenn das nicht
#   gewuenscht ist (z.B. weil dev-DB schon mit dem alten KMS_MASTER_KEY_B64
#   Daten encrypted hat), Script vorher checken oder mit FORCE=1 ausfuehren.
# ============================================================================

set -euo pipefail

# === Voraussetzungen ===
command -v doppler >/dev/null || { echo "✗ doppler-cli missing"; exit 1; }
command -v openssl >/dev/null || { echo "✗ openssl missing"; exit 1; }

PROJECT="mcp-knowledge2"
CONFIG="dev"

# Auth check
[[ -n "${DOPPLER_TOKEN:-}" ]] || {
  echo "✗ DOPPLER_TOKEN env-var missing"
  echo "  Tip: doppler-cli kann auch ohne env-var auth'd sein. Pruefe via:"
  echo "       doppler me"
  echo "  Falls personal-token bevorzugt:  export DOPPLER_TOKEN=dp.pt.xxx"
  # Nicht hart fail-en — doppler-cli wirft eigenen Auth-Error wenn noetig
}

# Project-existenz pruefen
if ! doppler configs --project "$PROJECT" --silent >/dev/null 2>&1; then
  echo "✗ Doppler-Project '$PROJECT' nicht gefunden."
  echo "  Erst Terraform laufen lassen: terraform -chdir=terraform/environments/privat apply"
  exit 1
fi

# Check if values already exist + non-empty
existing_check() {
  local key="$1"
  local val
  val=$(doppler secrets get "$key" --project "$PROJECT" --config "$CONFIG" --plain 2>/dev/null || true)
  [[ -n "$val" ]]
}

if [[ "${FORCE:-0}" != "1" ]]; then
  any_set=0
  for key in SERVICE_TOKEN KMS_MASTER_KEY_B64 BACKUP_MASTER_KEY; do
    if existing_check "$key"; then
      any_set=1
      break
    fi
  done
  if [[ $any_set -eq 1 ]]; then
    echo "⚠  Mindestens einer der 3 Crypto-Keys ist bereits in $PROJECT/$CONFIG gesetzt."
    echo "   Nochmal generieren wuerde existierende dev-Daten unbrauchbar machen"
    echo "   (DB-Bodies sind mit altem Key encrypted)."
    echo ""
    echo "   Wenn du wirklich neue Keys willst: FORCE=1 bash $0"
    exit 0
  fi
fi

echo "═══════════════════════════════════════════════════════════════"
echo "  Doppler-Seed: $PROJECT / $CONFIG"
echo "═══════════════════════════════════════════════════════════════"

# === Generate + Set (silent) ===
echo ""
echo "→ Generiere SERVICE_TOKEN (32 bytes hex)…"
SERVICE_TOKEN="$(openssl rand -hex 32)"
doppler secrets set "SERVICE_TOKEN=$SERVICE_TOKEN" --project "$PROJECT" --config "$CONFIG" --silent
unset SERVICE_TOKEN
echo "  ✓ SERVICE_TOKEN"

echo "→ Generiere KMS_MASTER_KEY_B64 (32 bytes base64)…"
KMS_KEY="$(openssl rand -base64 32)"
doppler secrets set "KMS_MASTER_KEY_B64=$KMS_KEY" --project "$PROJECT" --config "$CONFIG" --silent
unset KMS_KEY
echo "  ✓ KMS_MASTER_KEY_B64"

echo "→ Generiere BACKUP_MASTER_KEY (32 bytes base64)…"
BACKUP_KEY="$(openssl rand -base64 32)"
doppler secrets set "BACKUP_MASTER_KEY=$BACKUP_KEY" --project "$PROJECT" --config "$CONFIG" --silent
unset BACKUP_KEY
echo "  ✓ BACKUP_MASTER_KEY"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  ✓ Fertig. 3 Crypto-Keys in $PROJECT/$CONFIG gesetzt."
echo ""
echo "  Naechste Schritte:"
echo "    1. Google OAuth Client manuell in Google Cloud Console anlegen,"
echo "       GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET via"
echo "       Doppler-Web-UI in $PROJECT/$CONFIG eintragen."
echo "    2. VERTEX_PROJECT (GCP-Project-ID) eintragen (nur fuer Embed-Tests"
echo "       noetig — kann auch leer bleiben)."
echo "    3. Lokale Compose-Session: doppler run --project $PROJECT --config $CONFIG -- docker-compose up"
echo "═══════════════════════════════════════════════════════════════"
