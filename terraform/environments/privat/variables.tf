# --- Secrets / per-host values (fill in terraform.tfvars, NOT committed) ----

variable "hcloud_token" {
  type        = string
  default     = ""
  description = "Hetzner Cloud API token. Optional bei Doppler-only apply — wird später via Doppler."
  sensitive   = true
}

variable "operator_ssh_public_key" {
  type        = string
  default     = ""
  description = "Operator SSH public key. Optional bei Doppler-only apply."
}

variable "cloudflare_zone_id" {
  type        = string
  default     = ""
  description = "Cloudflare zone ID. Optional bei Doppler-only apply."
}

# --- Tunables with sensible defaults ----------------------------------------

variable "server_type" {
  type        = string
  default     = "cpx22"
  description = "Hetzner server type. cpx22 = 2 vCPU / 4 GB RAM / 80 GB, ~8.64 EUR/Mo (cx21+cpx21 beide EOL fuer fsn1 ab 2026-05). Upgrade-Path bei OOM: cpx32 (4c/8GB/160GB, ~15.12 EUR/Mo) via live-rescale."
}

variable "location" {
  type        = string
  default     = "fsn1"
  description = "Hetzner location (fsn1 = Frankfurt)."
}

variable "allowed_ssh_ips" {
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
  description = "CIDRs allowed to SSH. Restrict to operator IP-ranges in production."
}

variable "data_volume_size_gb" {
  type        = number
  default     = 0
  description = "If > 0, attach an extra Hetzner volume of this size (GB) for persistent data (pgdata, R2-cache)."
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

# --- GitHub-Terraform inputs ------------------------------------------------
#
# These power the `github-repo` module (see github.tf). The GitHub provider
# itself reads its token from $GITHUB_TOKEN — that env-var is NOT a Terraform
# variable, just a runtime requirement.
#
# All sensitive values are gitignored via .tfvars rules — never commit
# terraform.tfvars.

variable "cloudflare_api_token" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Cloudflare API token. Optional now — kommt via Doppler-Sync nach Setup."
}

variable "cloudflare_account_id" {
  type        = string
  default     = ""
  description = "Cloudflare account ID (öffentlich, sichtbar in Dashboard-URLs). Needed for account-scoped Resources (R2, AI Gateway, Workers AI). Kommt via Doppler-Sync."
}

variable "r2_access_key_id" {
  type        = string
  sensitive   = true
  default     = ""
  description = "R2 access key. Optional now — kommt via Doppler-Sync."
}

variable "r2_secret_access_key" {
  type        = string
  sensitive   = true
  default     = ""
  description = "R2 secret key. Optional now — kommt via Doppler-Sync."
}

variable "hetzner_deploy_ssh_private_key" {
  type        = string
  sensitive   = true
  default     = ""
  description = "GH-Actions deploy-SSH-key. Optional now — kommt via Doppler-Sync."
}

variable "mcp_approval_internal_token" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Internal service-token. Optional now — kommt via Doppler-Sync."
}

variable "ghcr_token" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Optional PAT with read:packages for private ghcr.io pulls. Empty string skips creation of GHCR_TOKEN."
}
