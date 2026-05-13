# DNS records for a single mcp-approval2 instance (3 subdomains: mcp, knowledge, app).
#
# Uses cloudflare/cloudflare v5 → resource type is `cloudflare_dns_record`
# (not the legacy `cloudflare_record`).
#
# IPv6 records are created only when `target_ipv6` is non-empty — that keeps
# the module reusable for IPv4-only providers later.

locals {
  comment_prefix = "managed-by:terraform — mcp-approval2/${var.instance_name}"
}

# ----- mcp.<env>.ai-toolhub.org -----

resource "cloudflare_dns_record" "mcp" {
  zone_id = var.zone_id
  name    = var.domain_mcp
  type    = "A"
  content = var.target_ipv4
  proxied = var.proxied
  ttl     = var.proxied ? 1 : 300
  comment = "${local.comment_prefix} mcp A"
}

resource "cloudflare_dns_record" "mcp_v6" {
  count = var.target_ipv6 != "" ? 1 : 0

  zone_id = var.zone_id
  name    = var.domain_mcp
  type    = "AAAA"
  content = var.target_ipv6
  proxied = var.proxied
  ttl     = var.proxied ? 1 : 300
  comment = "${local.comment_prefix} mcp AAAA"
}

# ----- knowledge.<env>.ai-toolhub.org -----

resource "cloudflare_dns_record" "knowledge" {
  zone_id = var.zone_id
  name    = var.domain_knowledge
  type    = "A"
  content = var.target_ipv4
  proxied = var.proxied
  ttl     = var.proxied ? 1 : 300
  comment = "${local.comment_prefix} knowledge A"
}

resource "cloudflare_dns_record" "knowledge_v6" {
  count = var.target_ipv6 != "" ? 1 : 0

  zone_id = var.zone_id
  name    = var.domain_knowledge
  type    = "AAAA"
  content = var.target_ipv6
  proxied = var.proxied
  ttl     = var.proxied ? 1 : 300
  comment = "${local.comment_prefix} knowledge AAAA"
}

# ----- app.<env>.ai-toolhub.org -----

resource "cloudflare_dns_record" "app" {
  zone_id = var.zone_id
  name    = var.domain_app
  type    = "A"
  content = var.target_ipv4
  proxied = var.proxied
  ttl     = var.proxied ? 1 : 300
  comment = "${local.comment_prefix} app A"
}

resource "cloudflare_dns_record" "app_v6" {
  count = var.target_ipv6 != "" ? 1 : 0

  zone_id = var.zone_id
  name    = var.domain_app
  type    = "AAAA"
  content = var.target_ipv6
  proxied = var.proxied
  ttl     = var.proxied ? 1 : 300
  comment = "${local.comment_prefix} app AAAA"
}
