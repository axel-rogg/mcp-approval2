# --- Secrets / per-host values (fill in terraform.tfvars, NOT committed) ----

variable "hcloud_token" {
  type        = string
  description = "Hetzner Cloud API token (project-scoped). Source from password manager."
  sensitive   = true
}

variable "operator_ssh_public_key" {
  type        = string
  description = "Operator SSH public key (OpenSSH single-line, e.g. 'ssh-ed25519 AAAA... operator@laptop')."
}

variable "cloudflare_zone_id" {
  type        = string
  description = "Cloudflare zone ID for ai-toolhub.org (32-char hex). Look up with: curl -s 'https://api.cloudflare.com/client/v4/zones?name=ai-toolhub.org' -H \"Authorization: Bearer $CLOUDFLARE_API_TOKEN\" | jq -r '.result[0].id'"
}

# --- Tunables with sensible defaults ----------------------------------------

variable "server_type" {
  type        = string
  default     = "cx21"
  description = "Hetzner server type. cx21 = 4 vCPU / 8 GB RAM, ~6 EUR/Mo."
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
