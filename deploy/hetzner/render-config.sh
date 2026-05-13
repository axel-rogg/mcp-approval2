#!/usr/bin/env bash
# render-config.sh — substitute ${VAR} placeholders in *.tpl files using .env
#
# Renders:
#   Caddyfile.tpl       → Caddyfile
#   cloud-init.yaml.tpl → cloud-init.yaml   (only if SSH_PUBLIC_KEY is set)
#
# Usage:  bash render-config.sh
# Requires: envsubst (gettext-base on Debian/Ubuntu)

set -euo pipefail

cd "$(dirname "$0")"

if ! command -v envsubst >/dev/null 2>&1; then
  echo "ERROR: envsubst not found. Install with: apt-get install gettext-base" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "ERROR: .env missing. Run: bash generate-secrets.sh > .env" >&2
  exit 1
fi

# Load .env into the current shell. We export every line that's a plain
# KEY=VALUE so envsubst sees them.
set -a
# shellcheck disable=SC1091
. ./.env
set +a

# ── Caddyfile ─────────────────────────────────────────────────────────
if [[ -f Caddyfile.tpl ]]; then
  echo "→ Rendering Caddyfile.tpl → Caddyfile"
  # Only substitute the domain/email vars (not arbitrary ${...} in caddy syntax).
  envsubst '${ACME_EMAIL} ${DOMAIN_MCP} ${DOMAIN_KNOWLEDGE} ${DOMAIN_APP}' \
    < Caddyfile.tpl > Caddyfile
fi

# ── cloud-init.yaml (only if ssh key is provided) ─────────────────────
if [[ -f cloud-init.yaml.tpl && -n "${SSH_PUBLIC_KEY:-}" ]]; then
  echo "→ Rendering cloud-init.yaml.tpl → cloud-init.yaml"
  envsubst '${SSH_PUBLIC_KEY}' \
    < cloud-init.yaml.tpl > cloud-init.yaml
else
  echo "  (skipping cloud-init.yaml render — SSH_PUBLIC_KEY not set; this is" \
       "normal for runtime renders. Terraform renders it during VM bootstrap.)"
fi

echo "✓ Render complete."
