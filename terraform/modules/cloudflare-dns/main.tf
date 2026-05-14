# DNS records for a single mcp-approval2 instance (3 subdomains: mcp, knowledge, app).
#
# Uses cloudflare/cloudflare v5 → resource type is `cloudflare_dns_record`
# (not the legacy `cloudflare_record`).
#
# IPv6 records are created only when `target_ipv6` is non-empty — that keeps
# the module reusable for IPv4-only providers later.

locals {
  comment_prefix = "managed-by:terraform — mcp-approval2/${var.instance_name}"

  # ---------------------------------------------------------------------------
  # Reserved subdomain-prefixes that are owned by mcp-approval/terraform/.
  # Setting var.domain_mcp/domain_knowledge/domain_app to any of these
  # would hijack a record that the OTHER terraform-state already manages
  # (cross-state conflict, instant outage of the production mcp-approval).
  #
  # Adding here is safer than relying on humans to remember — the
  # precondition below blocks `terraform plan/apply` before any API call
  # to Cloudflare goes out.
  # ---------------------------------------------------------------------------
  reserved_subdomains = [
    "mcp",
    "app",
    "knowledge",
    "knowledge-core",
    "gws",
    "gcloud",
    "utils",
  ]

  mcp_subdomain       = split(".", var.domain_mcp)[0]
  knowledge_subdomain = split(".", var.domain_knowledge)[0]
  app_subdomain       = split(".", var.domain_app)[0]
}

# Validation gate — every cloudflare_dns_record below depends_on this,
# so any reserved-name assignment surfaces as an actionable error before
# Terraform writes anything.
resource "terraform_data" "validate_domains" {
  input = {
    mcp       = local.mcp_subdomain
    knowledge = local.knowledge_subdomain
    app       = local.app_subdomain
  }

  lifecycle {
    precondition {
      condition     = !contains(local.reserved_subdomains, local.mcp_subdomain)
      error_message = "domain_mcp subdomain '${local.mcp_subdomain}' ist reserved fuer existing mcp-approval/terraform/. Use mcp2 oder andere nicht-reservierte Namen."
    }
    precondition {
      condition     = !contains(local.reserved_subdomains, local.knowledge_subdomain)
      error_message = "domain_knowledge subdomain '${local.knowledge_subdomain}' ist reserved fuer existing mcp-approval/terraform/. Use knowledge2 oder andere nicht-reservierte Namen."
    }
    precondition {
      condition     = !contains(local.reserved_subdomains, local.app_subdomain)
      error_message = "domain_app subdomain '${local.app_subdomain}' ist reserved fuer existing mcp-approval/terraform/. Use app2 oder andere nicht-reservierte Namen."
    }
  }
}

# ----- mcp.<env>.ai-toolhub.org -----

resource "cloudflare_dns_record" "mcp" {
  depends_on = [terraform_data.validate_domains]

  zone_id = var.zone_id
  name    = var.domain_mcp
  type    = "A"
  content = var.target_ipv4
  proxied = var.proxied
  ttl     = var.proxied ? 1 : 300
  comment = "${local.comment_prefix} mcp A"
}

resource "cloudflare_dns_record" "mcp_v6" {
  count      = var.target_ipv6 != "" ? 1 : 0
  depends_on = [terraform_data.validate_domains]

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
  depends_on = [terraform_data.validate_domains]

  zone_id = var.zone_id
  name    = var.domain_knowledge
  type    = "A"
  content = var.target_ipv4
  proxied = var.proxied
  ttl     = var.proxied ? 1 : 300
  comment = "${local.comment_prefix} knowledge A"
}

resource "cloudflare_dns_record" "knowledge_v6" {
  count      = var.target_ipv6 != "" ? 1 : 0
  depends_on = [terraform_data.validate_domains]

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
  depends_on = [terraform_data.validate_domains]

  zone_id = var.zone_id
  name    = var.domain_app
  type    = "A"
  content = var.target_ipv4
  proxied = var.proxied
  ttl     = var.proxied ? 1 : 300
  comment = "${local.comment_prefix} app A"
}

resource "cloudflare_dns_record" "app_v6" {
  count      = var.target_ipv6 != "" ? 1 : 0
  depends_on = [terraform_data.validate_domains]

  zone_id = var.zone_id
  name    = var.domain_app
  type    = "AAAA"
  content = var.target_ipv6
  proxied = var.proxied
  ttl     = var.proxied ? 1 : 300
  comment = "${local.comment_prefix} app AAAA"
}
