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

  # HETZNER_FQDN_V4 is optional. If it's empty (or not set), strip the
  # entire bypass vhost-block from the template before envsubst runs — a
  # bare "{ ... }"-block with no hostname would crash Caddy.
  # The block is delimited by "# ── Coop-Bypass:" (start) and the matching
  # closing "}" of the vhost (which is the line containing only "}" right
  # after the reverse_proxy stanza).
  if [[ -z "${HETZNER_FQDN_V4:-}" ]]; then
    echo "  (HETZNER_FQDN_V4 unset — omitting Coop-Bypass vhost)"
    awk '
      /^# ── Coop-Bypass:/ { skip = 1 }
      skip && /^\}$/        { skip = 0; next }
      !skip                  { print }
    ' Caddyfile.tpl > Caddyfile.tpl.tmp
  else
    cp Caddyfile.tpl Caddyfile.tpl.tmp
  fi

  # Only substitute the domain/email vars (not arbitrary ${...} in caddy syntax).
  envsubst '${ACME_EMAIL} ${DOMAIN_MCP} ${DOMAIN_KNOWLEDGE} ${DOMAIN_APP} ${HETZNER_FQDN_V4}' \
    < Caddyfile.tpl.tmp > Caddyfile
  rm -f Caddyfile.tpl.tmp
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
