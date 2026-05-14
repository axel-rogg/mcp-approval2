# =============================================================================
# Actions secrets and variables.
#
# Post-Doppler-migration (2026-05-14):
#   - Doppler is the Single-Source-of-Truth for ALL workflow secrets.
#   - The Doppler->GitHub-Actions sync (activated manually in the Doppler UI,
#     see README.md "Doppler-Integration") pushes every secret of the
#     `privat`-config into the matching GitHub environment automatically.
#   - The ONLY secret Terraform still pushes directly is DOPPLER_TOKEN_GHA —
#     the service-token GH-Actions needs to authenticate against Doppler in
#     the first place. This is a chicken-and-egg: the auth token cannot
#     itself be fetched from Doppler at workflow start.
#
# All previously-managed direct secrets (CLOUDFLARE_API_TOKEN, HCLOUD_TOKEN,
# R2_*, OPERATOR_SSH_PUBLIC_KEY, HETZNER_SSH_PRIVATE_KEY, HETZNER_VM_HOST,
# HETZNER_DOMAIN_*, MCP_APPROVAL_INTERNAL_TOKEN, GHCR_TOKEN) are now sourced
# via the Doppler sync. Do NOT add them back here.
#
# State-sensitivity note: the DOPPLER_TOKEN_GHA value still lands in the
# Terraform state file in plaintext — the R2/EU backend therefore MUST stay
# encrypted at rest. See README.md.
# =============================================================================

# -----------------------------------------------------------------------------
# Bootstrap secret #1 — repo-level: Doppler service-token for GitHub Actions.
# Exposed to every workflow as $DOPPLER_TOKEN_GHA; workflows use
#   `doppler secrets download --token "$DOPPLER_TOKEN_GHA" ...`
# to pull the full secret-set at job start.
# -----------------------------------------------------------------------------
resource "github_actions_secret" "doppler_token_gha" {
  repository      = github_repository.settings.name
  secret_name     = "DOPPLER_TOKEN_GHA"
  plaintext_value = var.doppler_gha_service_token
}

# -----------------------------------------------------------------------------
# Bootstrap secret #2 — environment-level mirror: same token under the
# conventional `DOPPLER_TOKEN` name in the `hetzner-production` environment.
# Some workflows / actions look for `DOPPLER_TOKEN` by default; the duplicate
# scoping keeps both call-styles supported.
# -----------------------------------------------------------------------------
resource "github_actions_environment_secret" "doppler_token_env" {
  repository      = github_repository.settings.name
  environment     = github_repository_environment.hetzner_prod.environment
  secret_name     = "DOPPLER_TOKEN"
  plaintext_value = var.doppler_gha_service_token
}

# -----------------------------------------------------------------------------
# Repository-level Actions variables (non-sensitive, visible in workflow logs).
# Kept (not migrated to Doppler) because it's plain config, not a secret —
# Doppler-Sync would also push it but Terraform-managed keeps it deterministic.
# -----------------------------------------------------------------------------
resource "github_actions_variable" "default_env" {
  repository    = github_repository.settings.name
  variable_name = "DEFAULT_ENVIRONMENT"
  value         = "hetzner-production"
}
