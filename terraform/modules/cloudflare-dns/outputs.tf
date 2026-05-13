output "fqdns" {
  value = [
    cloudflare_dns_record.mcp.name,
    cloudflare_dns_record.knowledge.name,
    cloudflare_dns_record.app.name,
  ]
  description = "Flat list of all FQDNs managed by this module (A-records only)."
}

output "domain_mcp" {
  value       = cloudflare_dns_record.mcp.name
  description = "MCP-API FQDN."
}

output "domain_knowledge" {
  value       = cloudflare_dns_record.knowledge.name
  description = "Knowledge-Service FQDN."
}

output "domain_app" {
  value       = cloudflare_dns_record.app.name
  description = "PWA FQDN."
}

output "urls" {
  value = {
    mcp       = "https://${cloudflare_dns_record.mcp.name}"
    knowledge = "https://${cloudflare_dns_record.knowledge.name}"
    app       = "https://${cloudflare_dns_record.app.name}"
  }
  description = "Fully-qualified https URLs for each surface."
}
