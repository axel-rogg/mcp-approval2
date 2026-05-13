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
  # `nonsensitive()` strips the sensitivity propagation from var.ghcr_token —
  # we only branch on whether the string is empty, not on its content, so it's
  # safe to expose. The output itself contains secret NAMES, never values.
  value = compact([
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ZONE_ID",
    "HCLOUD_TOKEN",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "OPERATOR_SSH_PUBLIC_KEY",
    "HETZNER_SSH_PRIVATE_KEY",
    "HETZNER_VM_HOST",
    "HETZNER_DOMAIN_MCP",
    "HETZNER_DOMAIN_KNOWLEDGE",
    "HETZNER_DOMAIN_APP",
    "MCP_APPROVAL_INTERNAL_TOKEN",
    nonsensitive(var.ghcr_token) != "" ? "GHCR_TOKEN" : "",
  ])
  description = "List of GitHub Actions secret NAMES managed by this module (values are never exported)."
}
