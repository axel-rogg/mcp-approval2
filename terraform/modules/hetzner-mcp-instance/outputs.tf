output "vm_ipv4" {
  value       = hcloud_server.mcp.ipv4_address
  description = "Public IPv4 address of the Hetzner VM."
}

output "vm_ipv6" {
  value       = hcloud_server.mcp.ipv6_address
  description = "Public IPv6 address of the Hetzner VM."
}

output "ssh_user" {
  value       = "deploy"
  description = "Default SSH user created by cloud-init."
}

output "instance_id" {
  value       = hcloud_server.mcp.id
  description = "Hetzner server ID (numeric)."
}

output "volume_id" {
  value       = length(hcloud_volume.data) > 0 ? hcloud_volume.data[0].id : null
  description = "Hetzner volume ID, or null when no data volume is attached."
}

output "firewall_id" {
  value       = hcloud_firewall.mcp.id
  description = "Hetzner firewall ID — handy for follow-up attach of sibling resources."
}

# ---------------------------------------------------------------------------
# Coop-bypass-FQDNs.
#
# Hetzner gibt jeder VM eine Default-Reverse-DNS-FQDN unter `*.your-server.de`
# (IPv4 + IPv6 unabhaengig). Diese Adressen sind nicht "newly registered" und
# werden vom Coop-Zscaler-Proxy durchgelassen, waehrend `*.ai-toolhub.org`
# geblockt wird. Let's Encrypt funktioniert fuer beide.
#
# Siehe docs/runbooks/runbook-coop-bypass.md.
# ---------------------------------------------------------------------------

output "default_hetzner_fqdn_v4" {
  description = "Hetzner default reverse-DNS FQDN (IPv4-based). Dies wird vom Coop-Zscaler durchgelassen, waehrend *.ai-toolhub.org als 'newly registered' geblockt wird."
  value = format(
    "static.%s.clients.your-server.de",
    join(".", reverse(split(".", hcloud_server.mcp.ipv4_address)))
  )
}

output "default_hetzner_fqdn_v6" {
  description = "Hetzner default reverse-DNS FQDN (IPv6-based). Selten benutzt — Format-Detail differiert je nach Hetzner-Pool; bei Bedarf manuell verifizieren."
  value = hcloud_server.mcp.ipv6_address != "" ? format(
    "%s.clients.your-server.de",
    replace(hcloud_server.mcp.ipv6_address, ":", "-")
  ) : ""
}
