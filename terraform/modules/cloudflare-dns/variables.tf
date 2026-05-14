variable "zone_id" {
  type        = string
  description = "Cloudflare zone ID for ai-toolhub.org (32-char hex)."
}

variable "instance_name" {
  type        = string
  description = "Identifier for the instance (privat | business). Used in resource comments."
}

variable "target_ipv4" {
  type        = string
  description = "Public IPv4 the DNS records should point to (e.g. the Hetzner VM IPv4)."
}

variable "target_ipv6" {
  type        = string
  description = "Public IPv6 for AAAA records. Hetzner servers always have IPv6 enabled by default."
}

variable "domain_mcp" {
  type        = string
  description = "FQDN for the MCP-API surface (e.g. mcp2.ai-toolhub.org)."
}

variable "domain_knowledge" {
  type        = string
  description = "FQDN for the Knowledge-Service (e.g. knowledge2.ai-toolhub.org)."
}

variable "domain_app" {
  type        = string
  description = "FQDN for the PWA (e.g. app2.ai-toolhub.org)."
}

variable "proxied" {
  type        = bool
  default     = false
  description = "If true, Cloudflare proxies traffic (orange-cloud). WebAuthn passkeys require an unproxied A-record so set false unless you understand the cert-chain implications."
}
