#!/usr/bin/env bash
# generate-secrets.sh — emit a fresh .env to stdout for an initial Hetzner deploy.
#
# Usage:
#   bash generate-secrets.sh > .env
#   nano .env              # fill GOOGLE_OAUTH_*, DOMAIN_* if defaults wrong
#
# What it generates:
#   - POSTGRES_PASSWORD                (24-byte hex)
#   - MCP_APPROVAL_INTERNAL_TOKEN      (32-byte hex)
#   - KNOWLEDGE_BACKUP_MASTER_KEY_BASE64 (32 raw bytes → base64)
#   - JWT_RS256_PRIVATE_KEY_PEM         (RSA 2048-bit, escaped newlines)
#   - JWT_RS256_PUBLIC_KEY_PEM          (derived from above)
#   - JWT_KID                           (key-YYYY-MM-DD)
#
# What you must fill manually:
#   - VAULT_TOKEN              (set after `bash vault-init.sh`)
#   - GOOGLE_OAUTH_CLIENT_ID + SECRET
#   - VERTEX_AI_PROJECT_ID     (optional)
#   - DOMAIN_*                 (defaults to ai-toolhub.org Phase A names)

set -euo pipefail

# Sanity: openssl is required.
if ! command -v openssl >/dev/null 2>&1; then
  echo "ERROR: openssl not found. Install with: apt-get install openssl" >&2
  exit 1
fi

cat <<HEADER
# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by generate-secrets.sh
# DO NOT COMMIT THIS FILE. It is gitignored.

# ============================================================================
# Database
# ============================================================================
POSTGRES_PASSWORD=$(openssl rand -hex 24)

# ============================================================================
# Vault / OpenBao
# ============================================================================
# Set this AFTER running: bash vault-init.sh
VAULT_TOKEN=set-after-bao-operator-init

# ============================================================================
# Internal Service Token (Sub-MCPs ⇄ Approval, Approval ⇄ Knowledge2)
# ============================================================================
MCP_APPROVAL_INTERNAL_TOKEN=$(openssl rand -hex 32)

# ============================================================================
# mcp-knowledge2 backup master key (base64, 32 bytes)
# ============================================================================
KNOWLEDGE_BACKUP_MASTER_KEY_BASE64=$(openssl rand 32 | base64 | tr -d '\n')

HEADER

# RS256 keypair. We use awk to convert real newlines to literal "\n" so the
# value survives a single .env line. Compose unescapes \n at container start.
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

openssl genpkey -algorithm RSA -out "$TMPDIR/private.pem" \
  -pkeyopt rsa_keygen_bits:2048 2>/dev/null
openssl rsa -in "$TMPDIR/private.pem" -pubout -out "$TMPDIR/public.pem" 2>/dev/null

PRIV=$(awk 'NF{printf "%s\\n", $0}' "$TMPDIR/private.pem")
PUB=$(awk 'NF{printf "%s\\n", $0}' "$TMPDIR/public.pem")

cat <<KEYS
# ============================================================================
# JWT RS256 signing keys (PEM with escaped newlines)
# ============================================================================
JWT_RS256_PRIVATE_KEY_PEM="${PRIV}"
JWT_RS256_PUBLIC_KEY_PEM="${PUB}"
JWT_KID=key-$(date -u +%Y-%m-%d)

# ============================================================================
# Domains (Phase A defaults — edit if you use different subdomains)
# ============================================================================
DOMAIN_MCP=mcp2.ai-toolhub.org
DOMAIN_KNOWLEDGE=knowledge2.ai-toolhub.org
DOMAIN_APP=app2.ai-toolhub.org
ACME_EMAIL=admin@ai-toolhub.org

# ============================================================================
# Google OAuth (Front-Door Login) — CREATE IN GOOGLE CLOUD CONSOLE
# ============================================================================
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=

# ============================================================================
# Vertex AI (optional)
# ============================================================================
VERTEX_AI_PROJECT_ID=
VERTEX_AI_REGION=europe-west4

# ============================================================================
# Sub-MCPs on Cloudflare (only override if you use a custom GitHub-MCP)
# ============================================================================
GATEWAY_GITHUB_URL=

# ============================================================================
# Logging + image tags
# ============================================================================
LOG_LEVEL=info
TAG=latest
KNOWLEDGE_TAG=latest
KEYS
