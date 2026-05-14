# =============================================================================
# Inputs for the github-repo module.
#
# Post-Doppler-migration (2026-05-14):
#   - All previously-managed direct secrets (Cloudflare API token, HCLOUD
#     token, R2 keys, SSH keys, domains, internal HMACs, GHCR PAT) are now
#     stored in Doppler. They no longer appear as Terraform variables here.
#   - The ONLY sensitive input left is `doppler_gha_service_token` — the
#     Doppler service-token Terraform pushes as a GH-Actions bootstrap
#     secret. It lands in the Terraform state file in plaintext, so the
#     R2/EU backend MUST stay encrypted at rest (see README.md).
# =============================================================================

# --- Repository identity / non-sensitive settings ---------------------------

variable "repository_full_name" {
  type        = string
  description = "GitHub repo in 'owner/name' form (e.g. 'axel-rogg/mcp-approval2'). The repo MUST already exist — this module only manages settings."
}

variable "repository_description" {
  type        = string
  default     = "Multi-User MCP-Approval Server (Hetzner + GCP)"
  description = "Short repo description shown on the GitHub UI."
}

variable "repository_visibility" {
  type        = string
  default     = "public"
  description = "Either 'public' or 'private'. Flipping a public repo to private has cost / search consequences — review before changing."

  validation {
    condition     = contains(["public", "private"], var.repository_visibility)
    error_message = "Must be 'public' or 'private'."
  }
}

variable "create_business_environment" {
  type        = bool
  default     = false
  description = "If true, also create the 'gcp-business' environment (Phase-2 multi-tenant work)."
}

# --- Doppler bootstrap token (the only secret left) -------------------------

variable "doppler_gha_service_token" {
  type        = string
  sensitive   = true
  description = "Doppler-Service-Token for GitHub Actions. Wire from module.doppler.github_actions_service_token in the environment workspace. Terraform pushes this as the DOPPLER_TOKEN_GHA repo-secret + DOPPLER_TOKEN environment-secret; everything else flows in through Doppler's GitHub-Actions-Sync."
}
