# =============================================================================
# GitHub-repository management for axel-rogg/mcp-approval2.
#
# Post-Doppler-migration (2026-05-14):
#   - Doppler is the Single-Source-of-Truth for ALL workflow secrets.
#   - The github-repo module only pushes the Doppler bootstrap token
#     (DOPPLER_TOKEN_GHA + DOPPLER_TOKEN env-mirror); the rest comes via the
#     Doppler -> GitHub-Actions sync. See terraform/modules/github-repo/README.md.
#
# Provider auth: the GitHub provider reads $GITHUB_TOKEN from the environment.
# Set before running terraform:
#   export GITHUB_TOKEN="ghp_xxxxx"   # classic PAT with repo + workflow scopes
# =============================================================================

provider "github" {
  # Reads GITHUB_TOKEN from env automatically.
  # Setting `owner` explicitly avoids needing GITHUB_OWNER:
  owner = "axel-rogg"
}

module "github" {
  source = "../../modules/github-repo"

  # Repo identity
  repository_full_name        = "axel-rogg/mcp-approval2"
  repository_description      = "Multi-User MCP-Approval (Hetzner Pilot)"
  repository_visibility       = "public"
  create_business_environment = false

  # Sole sensitive input: the Doppler service-token. Comes from the
  # doppler-setup module (sibling output `github_actions_service_token`).
  doppler_gha_service_token = module.doppler.github_actions_service_token
}

# --------------------------------------------------------------------------
# Outputs visible at `terraform output`.
# --------------------------------------------------------------------------

output "github_managed_secrets" {
  value       = module.github.managed_secrets
  description = "GH-Actions secret NAMES pushed DIRECTLY by Terraform (only the Doppler bootstrap pair). Everything else syncs in via Doppler."
}

output "github_environment_hetzner_prod" {
  value       = module.github.environment_hetzner_prod
  description = "Name of the hetzner-production GH environment."
}
