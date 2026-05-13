# =============================================================================
# GitHub-repository management for axel-rogg/mcp-approval2.
#
# The repo is managed declaratively: settings, branch-protection,
# `hetzner-production` environment, and all Actions secrets are converged
# every `terraform apply`.
#
# Provider auth: the GitHub provider reads $GITHUB_TOKEN from the environment.
# Set before running terraform:
#   export GITHUB_TOKEN="ghp_xxxxx"   # classic PAT with repo + workflow scopes
# =============================================================================

provider "github" {
  # Reads GITHUB_TOKEN + GITHUB_OWNER from env automatically.
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

  # Repository-level secrets
  cloudflare_api_token    = var.cloudflare_api_token
  cloudflare_zone_id      = var.cloudflare_zone_id
  hcloud_token            = var.hcloud_token
  r2_access_key_id        = var.r2_access_key_id
  r2_secret_access_key    = var.r2_secret_access_key
  operator_ssh_public_key = var.operator_ssh_public_key

  # Hetzner-production environment secrets
  hetzner_deploy_ssh_private_key = var.hetzner_deploy_ssh_private_key
  hetzner_vm_host                = module.vm.vm_ipv4
  domain_mcp                     = var.domain_mcp
  domain_knowledge               = var.domain_knowledge
  domain_app                     = var.domain_app
  mcp_approval_internal_token    = var.mcp_approval_internal_token
  ghcr_token                     = var.ghcr_token
}

# --------------------------------------------------------------------------
# Outputs visible at `terraform output`.
# --------------------------------------------------------------------------

output "github_managed_secrets" {
  value       = module.github.managed_secrets
  description = "Names of GitHub Actions secrets managed by Terraform (values not exposed)."
}

output "github_environment_hetzner_prod" {
  value       = module.github.environment_hetzner_prod
  description = "Name of the hetzner-production GH environment."
}
