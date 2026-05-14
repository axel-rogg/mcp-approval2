# =============================================================================
# Module outputs — references downstream modules / environments can consume.
# Note: secret VALUES are NEVER exported, only their NAMES.
# =============================================================================

output "repository_name" {
  value       = github_repository.settings.name
  description = "Short repo name (without owner prefix)."
}

output "repository_full_name" {
  value       = data.github_repository.this.full_name
  description = "owner/name form, for cross-module references."
}

output "repository_node_id" {
  value       = github_repository.settings.node_id
  description = "GraphQL node ID (used as a key for branch-protection downstream)."
}

output "environment_hetzner_prod" {
  value       = github_repository_environment.hetzner_prod.environment
  description = "Name of the hetzner-production environment."
}

output "environment_gcp_business" {
  value       = var.create_business_environment ? github_repository_environment.gcp_business[0].environment : null
  description = "Name of the gcp-business environment, or null when the flag is false."
}

output "managed_secrets" {
  value = [
    "DOPPLER_TOKEN_GHA",           # repo-level — bootstrap token for workflows
    "DOPPLER_TOKEN (environment)", # hetzner-production env-scoped mirror
  ]
  description = "GitHub Actions secret NAMES managed DIRECTLY by Terraform. Everything else (CLOUDFLARE_API_TOKEN, HCLOUD_TOKEN, R2_*, HETZNER_*, ...) is pushed automatically by the Doppler->GitHub-Actions sync (see README.md)."
}
