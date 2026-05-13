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
