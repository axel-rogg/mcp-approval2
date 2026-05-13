# =============================================================================
# Actions secrets and variables.
#
# Secrets are written as plaintext to the API but stored encrypted at GitHub.
# They will, however, appear in the Terraform state file in plaintext — see
# README.md for the state-encryption requirement.
#
# Convention: repository-level secrets are shared across all workflows.
# Environment-level secrets are gated by environment protection rules (e.g.
# branch-pattern, required reviewers).
# =============================================================================

# -----------------------------------------------------------------------------
# Repository-level secrets (visible to every workflow run).
# -----------------------------------------------------------------------------

resource "github_actions_secret" "cloudflare_api_token" {
  repository      = github_repository.settings.name
  secret_name     = "CLOUDFLARE_API_TOKEN"
  plaintext_value = var.cloudflare_api_token
}

resource "github_actions_secret" "cloudflare_zone_id" {
  repository      = github_repository.settings.name
  secret_name     = "CLOUDFLARE_ZONE_ID"
  plaintext_value = var.cloudflare_zone_id
}

resource "github_actions_secret" "hcloud_token" {
  repository      = github_repository.settings.name
  secret_name     = "HCLOUD_TOKEN"
  plaintext_value = var.hcloud_token
}

resource "github_actions_secret" "r2_access_key_id" {
  repository      = github_repository.settings.name
  secret_name     = "R2_ACCESS_KEY_ID"
  plaintext_value = var.r2_access_key_id
}

resource "github_actions_secret" "r2_secret_access_key" {
  repository      = github_repository.settings.name
  secret_name     = "R2_SECRET_ACCESS_KEY"
  plaintext_value = var.r2_secret_access_key
}

resource "github_actions_secret" "operator_ssh_public_key" {
  repository      = github_repository.settings.name
  secret_name     = "OPERATOR_SSH_PUBLIC_KEY"
  plaintext_value = var.operator_ssh_public_key
}

# -----------------------------------------------------------------------------
# Environment 'hetzner-production' secrets.
# -----------------------------------------------------------------------------

resource "github_actions_environment_secret" "hetzner_ssh_key" {
  repository      = github_repository.settings.name
  environment     = github_repository_environment.hetzner_prod.environment
  secret_name     = "HETZNER_SSH_PRIVATE_KEY"
  plaintext_value = var.hetzner_deploy_ssh_private_key
}

resource "github_actions_environment_secret" "hetzner_vm_host" {
  repository      = github_repository.settings.name
  environment     = github_repository_environment.hetzner_prod.environment
  secret_name     = "HETZNER_VM_HOST"
  plaintext_value = var.hetzner_vm_host
}

resource "github_actions_environment_secret" "domain_mcp" {
  repository      = github_repository.settings.name
  environment     = github_repository_environment.hetzner_prod.environment
  secret_name     = "HETZNER_DOMAIN_MCP"
  plaintext_value = var.domain_mcp
}

resource "github_actions_environment_secret" "domain_knowledge" {
  repository      = github_repository.settings.name
  environment     = github_repository_environment.hetzner_prod.environment
  secret_name     = "HETZNER_DOMAIN_KNOWLEDGE"
  plaintext_value = var.domain_knowledge
}

resource "github_actions_environment_secret" "domain_app" {
  repository      = github_repository.settings.name
  environment     = github_repository_environment.hetzner_prod.environment
  secret_name     = "HETZNER_DOMAIN_APP"
  plaintext_value = var.domain_app
}

resource "github_actions_environment_secret" "mcp_approval_internal_token" {
  repository      = github_repository.settings.name
  environment     = github_repository_environment.hetzner_prod.environment
  secret_name     = "MCP_APPROVAL_INTERNAL_TOKEN"
  plaintext_value = var.mcp_approval_internal_token
}

resource "github_actions_environment_secret" "ghcr_token" {
  count           = var.ghcr_token != "" ? 1 : 0
  repository      = github_repository.settings.name
  environment     = github_repository_environment.hetzner_prod.environment
  secret_name     = "GHCR_TOKEN"
  plaintext_value = var.ghcr_token
}

# -----------------------------------------------------------------------------
# Repository-level Actions variables (non-sensitive, visible in workflow logs).
# -----------------------------------------------------------------------------

resource "github_actions_variable" "default_env" {
  repository    = github_repository.settings.name
  variable_name = "DEFAULT_ENVIRONMENT"
  value         = "hetzner-production"
}
