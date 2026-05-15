#!/usr/bin/env bash
# doppler-run-terraform.sh — Runs terraform with Doppler-injected secrets.
#
# Doppler is Single-Source-of-Truth for all credentials. This wrapper:
#   1. Sources .dev.vars (only DOPPLER_TOKEN strictly needed; AWS_* fallback
#      for the very first apply before Doppler has the R2 keys).
#   2. Pulls all secrets from doppler project=mcp-approval2 config=privat.
#   3. Maps Doppler-secret-names → terraform TF_VAR_* convention.
#   4. Exposes provider-native env-vars (HCLOUD_TOKEN, CLOUDFLARE_API_TOKEN,
#      GITHUB_TOKEN, AWS_* for the R2 backend).
#   5. Execs `terraform <args>` in the environments/privat directory.
#
# Usage:
#   bash scripts/doppler-run-terraform.sh plan
#   bash scripts/doppler-run-terraform.sh apply
#   bash scripts/doppler-run-terraform.sh output -raw doppler_vm_token
#
# Why a wrapper and not plain `doppler run -- terraform`:
#   Doppler exposes secrets under their stored names (HCLOUD_TOKEN,
#   OPERATOR_SSH_PUBLIC_KEY, …). Terraform expects user-vars under
#   TF_VAR_<lowercase>. Without explicit mapping the modules would fall
#   through to default = "" and produce broken plans.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TF_DIR="$REPO_ROOT/terraform/environments/privat"

# ── 1. .dev.vars (only DOPPLER_TOKEN strictly required; AWS_* are a
#      bootstrap fallback so the very first `terraform init` can talk to
#      the R2 backend before Doppler holds the same keys). ──
if [[ -f "$REPO_ROOT/.dev.vars" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.dev.vars"
  set +a
fi

[[ -n "${DOPPLER_TOKEN:-}" ]] || {
  echo "ERROR: DOPPLER_TOKEN not set. Add it to .dev.vars or export it." >&2
  exit 1
}

command -v doppler >/dev/null || {
  echo "ERROR: doppler-cli missing. Run scripts/doppler-bootstrap.sh first." >&2
  exit 1
}

# ── 2. Pull all secrets as one JSON blob → faster than per-secret calls. ──
SECRETS_JSON="$(doppler secrets --json -p mcp-approval2 -c privat 2>/dev/null)" || {
  echo "ERROR: failed to read secrets from Doppler. Check DOPPLER_TOKEN scope." >&2
  exit 1
}

doppler_get() {
  # Empty / missing keys return ''. jq -r prints 'null' otherwise — strip it.
  jq -r --arg k "$1" '.[$k].computed // ""' <<<"$SECRETS_JSON"
}

# ── 3. TF_VAR_* mapping (only the variables declared in
#      environments/privat/variables.tf).
#
# Split `local var=$(...)` into two statements so jq-failures surface via
# `set -e` instead of being swallowed by `export`'s always-success exit
# (shellcheck SC2155). ──
TF_VAR_hcloud_token="$(doppler_get HCLOUD_TOKEN)"
TF_VAR_operator_ssh_public_key="$(doppler_get OPERATOR_SSH_PUBLIC_KEY)"
TF_VAR_cloudflare_account_id="$(doppler_get CLOUDFLARE_ACCOUNT_ID)"
TF_VAR_cloudflare_zone_id="$(doppler_get CLOUDFLARE_ZONE_ID)"
TF_VAR_cloudflare_api_token="$(doppler_get CLOUDFLARE_API_TOKEN)"
TF_VAR_r2_access_key_id="$(doppler_get AWS_ACCESS_KEY_ID)"
TF_VAR_r2_secret_access_key="$(doppler_get AWS_SECRET_ACCESS_KEY)"
TF_VAR_hetzner_deploy_ssh_private_key="$(doppler_get HETZNER_DEPLOY_SSH_PRIVATE_KEY)"
TF_VAR_mcp_approval_internal_token="$(doppler_get MCP_APPROVAL_INTERNAL_TOKEN)"
export TF_VAR_hcloud_token TF_VAR_operator_ssh_public_key \
  TF_VAR_cloudflare_account_id TF_VAR_cloudflare_zone_id TF_VAR_cloudflare_api_token \
  TF_VAR_r2_access_key_id TF_VAR_r2_secret_access_key \
  TF_VAR_hetzner_deploy_ssh_private_key TF_VAR_mcp_approval_internal_token

# Optional: GHCR PAT for private package pulls — empty string is fine.
export TF_VAR_ghcr_token=""

# Domains: defaults already match in variables.tf, no overrides needed.

# ── 4. Provider-native env-vars. ──
HCLOUD_TOKEN="$(doppler_get HCLOUD_TOKEN)"
CLOUDFLARE_API_TOKEN="$(doppler_get CLOUDFLARE_API_TOKEN)"
GITHUB_TOKEN="$(doppler_get GITHUB_TOKEN)"
export HCLOUD_TOKEN CLOUDFLARE_API_TOKEN GITHUB_TOKEN

# R2 backend uses S3 protocol → reads AWS_* from env. Already loaded from
# .dev.vars above; re-export from Doppler if present (Doppler wins for
# steady-state runs).
AWS_KID_DOPPLER="$(doppler_get AWS_ACCESS_KEY_ID)"
AWS_SECRET_DOPPLER="$(doppler_get AWS_SECRET_ACCESS_KEY)"
[[ -n "$AWS_KID_DOPPLER"    ]] && export AWS_ACCESS_KEY_ID="$AWS_KID_DOPPLER"
[[ -n "$AWS_SECRET_DOPPLER" ]] && export AWS_SECRET_ACCESS_KEY="$AWS_SECRET_DOPPLER"

# ── 5. Sanity check — DOPPLER_TOKEN itself is the bootstrap secret for the
#      doppler provider in main.tf. ──
[[ -n "${TF_VAR_hcloud_token:-}" ]] || {
  echo "WARN: HCLOUD_TOKEN empty in Doppler. terraform plan will likely fail" >&2
  echo "       at module.vm — fill it in dashboard.doppler.com first." >&2
}

cd "$TF_DIR"
exec terraform "$@"
