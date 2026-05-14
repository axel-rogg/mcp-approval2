#!/usr/bin/env bash
# Bootstraps Doppler-Secrets fuer mcp-approval2/privat:
# - Gruppe A: kopiert existing values aus /workspaces/mcp-approval/.dev.vars
# - Gruppe B: generiert frische Crypto-Keys (RSA, VAPID, random tokens, SSH)
#
# Was DIESES Script NICHT macht:
# - Google OAuth Client (manuell in GCP Console)
# - Vertex AI Service-Account (manuell in GCP Console)
# - VM-generierte Secrets (POSTGRES_PASSWORD, VAULT_TOKEN — kommen nach setup.sh)

set -euo pipefail

# === Voraussetzungen ===
command -v doppler >/dev/null || { echo "✗ doppler-cli missing"; exit 1; }
command -v openssl >/dev/null || { echo "✗ openssl missing"; exit 1; }
command -v jq >/dev/null      || { echo "✗ jq missing"; exit 1; }

PROJECT="mcp-approval2"
CONFIG="privat"
OLD_REPO_VARS="/workspaces/mcp-approval/.dev.vars"

# Auth check
[[ -n "${DOPPLER_TOKEN:-}" ]] || { echo "✗ DOPPLER_TOKEN env-var missing. Run: set -a && source .dev.vars && set +a"; exit 1; }

echo "═══════════════════════════════════════════════════════════════"
echo "  Doppler-Bootstrap: $PROJECT / $CONFIG"
echo "═══════════════════════════════════════════════════════════════"

# === Gruppe A: aus mcp-approval/.dev.vars ===
echo ""
echo "→ Gruppe A: Werte aus mcp-approval/.dev.vars"

if [[ ! -f "$OLD_REPO_VARS" ]]; then
  echo "  ⚠  $OLD_REPO_VARS nicht gefunden — überspringe Gruppe A"
else
  declare -A GROUP_A
  while IFS='=' read -r key val; do
    [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    GROUP_A["$key"]="$val"
  done < <(grep -E "^(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ZONE_ID|CLOUDFLARE_ACCOUNT_ID|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|R2_ENDPOINT)=" "$OLD_REPO_VARS")

  for key in "${!GROUP_A[@]}"; do
    val="${GROUP_A[$key]}"
    val="${val%\"}"; val="${val#\"}"  # strip quotes if any
    if [[ -n "$val" ]]; then
      doppler secrets set "$key=$val" -p "$PROJECT" -c "$CONFIG" --silent
      echo "  ✓ $key"
    fi
  done
fi

# === Gruppe B: lokal generierte Secrets ===
echo ""
echo "→ Gruppe B: Crypto-Keys + Random-Tokens generieren"

# RSA-Keypair für JWT-RS256-Signing
TMPDIR=$(mktemp -d)
openssl genpkey -algorithm RSA -out "$TMPDIR/jwt.pem" -pkeyopt rsa_keygen_bits:2048 2>/dev/null
openssl rsa -in "$TMPDIR/jwt.pem" -pubout -out "$TMPDIR/jwt.pub" 2>/dev/null
JWT_PRIV=$(cat "$TMPDIR/jwt.pem")
JWT_PUB=$(cat "$TMPDIR/jwt.pub")

doppler secrets set "JWT_RS256_PRIVATE_KEY_PEM=$JWT_PRIV" -p "$PROJECT" -c "$CONFIG" --silent
doppler secrets set "JWT_RS256_PUBLIC_KEY_PEM=$JWT_PUB"   -p "$PROJECT" -c "$CONFIG" --silent
doppler secrets set "JWT_KID=key-$(date -u +%Y-%m-%d)"    -p "$PROJECT" -c "$CONFIG" --silent
echo "  ✓ JWT_RS256_PRIVATE_KEY_PEM (RSA-2048)"
echo "  ✓ JWT_RS256_PUBLIC_KEY_PEM"
echo "  ✓ JWT_KID"

# Random hex/base64 tokens
doppler secrets set "MCP_APPROVAL_INTERNAL_TOKEN=$(openssl rand -hex 32)" -p "$PROJECT" -c "$CONFIG" --silent
echo "  ✓ MCP_APPROVAL_INTERNAL_TOKEN"

doppler secrets set "POSTGRES_PASSWORD=$(openssl rand -hex 24)" -p "$PROJECT" -c "$CONFIG" --silent
echo "  ✓ POSTGRES_PASSWORD"

doppler secrets set "KNOWLEDGE_BACKUP_MASTER_KEY_BASE64=$(openssl rand 32 | base64 | tr -d '\n')" -p "$PROJECT" -c "$CONFIG" --silent
echo "  ✓ KNOWLEDGE_BACKUP_MASTER_KEY_BASE64"

# VAPID-Keys für Web-Push (curve prime256v1)
VAPID_PRIV_PEM=$(openssl ecparam -name prime256v1 -genkey -noout 2>/dev/null)
VAPID_PRIV_B64=$(echo "$VAPID_PRIV_PEM" | openssl ec -outform DER 2>/dev/null | tail -c +8 | head -c 32 | base64 | tr -d '=' | tr '/+' '_-')
VAPID_PUB_B64=$(echo "$VAPID_PRIV_PEM" | openssl ec -pubout -outform DER 2>/dev/null | tail -c 65 | base64 | tr -d '=' | tr '/+' '_-')

doppler secrets set "VAPID_PRIVATE_KEY=$VAPID_PRIV_B64" -p "$PROJECT" -c "$CONFIG" --silent
doppler secrets set "VAPID_PUBLIC_KEY=$VAPID_PUB_B64"   -p "$PROJECT" -c "$CONFIG" --silent
echo "  ✓ VAPID_PRIVATE_KEY (P-256)"
echo "  ✓ VAPID_PUBLIC_KEY"

# Operator SSH Public-Key (existing key wenn vorhanden)
if [[ -f "$HOME/.ssh/id_ed25519.pub" ]]; then
  doppler secrets set "OPERATOR_SSH_PUBLIC_KEY=$(cat "$HOME/.ssh/id_ed25519.pub")" -p "$PROJECT" -c "$CONFIG" --silent
  echo "  ✓ OPERATOR_SSH_PUBLIC_KEY (aus ~/.ssh/id_ed25519.pub)"
elif [[ -f "$HOME/.ssh/id_rsa.pub" ]]; then
  doppler secrets set "OPERATOR_SSH_PUBLIC_KEY=$(cat "$HOME/.ssh/id_rsa.pub")" -p "$PROJECT" -c "$CONFIG" --silent
  echo "  ✓ OPERATOR_SSH_PUBLIC_KEY (aus ~/.ssh/id_rsa.pub)"
else
  echo "  ⚠  Kein SSH-Key in ~/.ssh/ gefunden — OPERATOR_SSH_PUBLIC_KEY skipped"
  echo "     Generieren: ssh-keygen -t ed25519 -C 'operator@laptop'"
fi

# Hetzner-Deploy-SSH-Key (separat von Operator-Key, nur für GH-Actions)
ssh-keygen -t ed25519 -f "$TMPDIR/hetzner-deploy" -N "" -C "github-actions-hetzner-deploy" -q
doppler secrets set "HETZNER_DEPLOY_SSH_PRIVATE_KEY=$(cat "$TMPDIR/hetzner-deploy")" -p "$PROJECT" -c "$CONFIG" --silent
HETZNER_DEPLOY_PUB=$(cat "$TMPDIR/hetzner-deploy.pub")
echo "  ✓ HETZNER_DEPLOY_SSH_PRIVATE_KEY"
echo ""
echo "  ℹ Hetzner-Deploy SSH-Public-Key (auf VM nach Setup ergänzen):"
echo "    $HETZNER_DEPLOY_PUB"

rm -rf "$TMPDIR"

# ACME-Email default
doppler secrets set "ACME_EMAIL=$(git config --get user.email || echo 'admin@example.com')" -p "$PROJECT" -c "$CONFIG" --silent
echo "  ✓ ACME_EMAIL"

# === Status ===
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Status: Secrets in Doppler"
echo "═══════════════════════════════════════════════════════════════"

EMPTY=$(doppler secrets --json -p "$PROJECT" -c "$CONFIG" 2>/dev/null | \
  jq -r 'to_entries[] | select(.value.computed == null or .value.computed == "") | .key')

if [[ -z "$EMPTY" ]]; then
  echo "✓ Alle Secrets gefüllt!"
else
  echo "⚠  Folgende Secrets sind noch leer (manuell eintragen):"
  echo "$EMPTY" | sed 's/^/  - /'
fi

echo ""
echo "Doppler-Dashboard:"
echo "  https://dashboard.doppler.com/workplace/projects/$PROJECT/configs/$CONFIG"
