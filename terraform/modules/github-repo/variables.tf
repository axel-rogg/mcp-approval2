# =============================================================================
# Inputs for the github-repo module.
#
# All values that count as secrets (tokens, private keys, internal HMACs) are
# marked sensitive=true so Terraform redacts them in plan/apply output. They
# DO still land in the state file in plaintext — see README.md for the
# state-encryption-at-rest requirement.
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

# --- Repository-level secrets (visible to all workflows) --------------------

variable "cloudflare_api_token" {
  type        = string
  sensitive   = true
  description = "Cloudflare API token used by deploy + dns-management workflows. Scope at minimum to Zone:DNS:Edit + Worker Routes."
}

variable "cloudflare_zone_id" {
  type        = string
  description = "Cloudflare zone ID for ai-toolhub.org (32-char hex). Non-sensitive but per-account."
}

variable "hcloud_token" {
  type        = string
  sensitive   = true
  description = "Hetzner Cloud project-scoped API token (Read & Write)."
}

variable "r2_access_key_id" {
  type        = string
  sensitive   = true
  description = "R2 S3-compatible access key ID. Used by workflows that read/write tf-state or backups."
}

variable "r2_secret_access_key" {
  type        = string
  sensitive   = true
  description = "R2 S3-compatible secret access key. Pair to r2_access_key_id."
}

variable "operator_ssh_public_key" {
  type        = string
  description = "Operator SSH public key (OpenSSH single-line) for VM access. Public material, not sensitive — but kept here so workflows can read it without re-deriving."
}

# --- Environment 'hetzner-production' secrets -------------------------------

variable "hetzner_deploy_ssh_private_key" {
  type        = string
  sensitive   = true
  description = "PEM-encoded SSH private key for GH-Actions auto-deploy. MUST be a separate key from the operator key (different audit trail, rotatable without touching admin access)."
}

variable "hetzner_vm_host" {
  type        = string
  description = "IP or DNS name of the production Hetzner VM (passed through to workflows that SSH in). Wired from module.vm.vm_ipv4 in the privat workspace."
}

variable "domain_mcp" {
  type        = string
  default     = "mcp2.ai-toolhub.org"
  description = "FQDN for the MCP-API surface."
}

variable "domain_knowledge" {
  type        = string
  default     = "knowledge2.ai-toolhub.org"
  description = "FQDN for the Knowledge-Service."
}

variable "domain_app" {
  type        = string
  default     = "app2.ai-toolhub.org"
  description = "FQDN for the PWA."
}

variable "mcp_approval_internal_token" {
  type        = string
  sensitive   = true
  description = "Internal service-token shared between mcp-approval2 services. Must match the value in the VM's .env."
}

variable "ghcr_token" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Optional: GitHub PAT with read:packages scope, for private ghcr.io image pulls. Empty string disables the secret."
}
