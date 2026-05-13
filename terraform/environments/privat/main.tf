# Environment: privat
# ============================================================================
# Wires the Hetzner VM together with Cloudflare DNS for the personal /
# single-user instance of mcp-approval2.
#
# Bootstrap:
#   cp terraform.tfvars.example terraform.tfvars
#   nano terraform.tfvars              # fill ssh key, zone id, ssh-cidr
#   export HCLOUD_TOKEN=...            # from your password manager
#   export CLOUDFLARE_API_TOKEN=...    # from .dev.vars
#   export AWS_ACCESS_KEY_ID=...       # R2 backend creds, from .dev.vars
#   export AWS_SECRET_ACCESS_KEY=...
#   terraform init
#   terraform plan
#   terraform apply

provider "hcloud" {
  token = var.hcloud_token
}

provider "cloudflare" {
  # Reads CLOUDFLARE_API_TOKEN from env automatically.
}

module "vm" {
  source = "../../modules/hetzner-mcp-instance"

  instance_name           = "privat"
  environment             = "privat"
  server_type             = var.server_type
  location                = var.location
  operator_ssh_public_key = var.operator_ssh_public_key
  allowed_ssh_ips         = var.allowed_ssh_ips
  data_volume_size_gb     = var.data_volume_size_gb
}

module "dns" {
  source = "../../modules/cloudflare-dns"

  zone_id          = var.cloudflare_zone_id
  instance_name    = "privat"
  target_ipv4      = module.vm.vm_ipv4
  target_ipv6      = module.vm.vm_ipv6
  domain_mcp       = var.domain_mcp
  domain_knowledge = var.domain_knowledge
  domain_app       = var.domain_app
  proxied          = false # WebAuthn passkeys require direct A-record
}

# --------------------------------------------------------------------------
# Outputs — visible after `terraform apply` and via `terraform output`.
# --------------------------------------------------------------------------

output "vm_ipv4" {
  value       = module.vm.vm_ipv4
  description = "Public IPv4 of the Hetzner VM."
}

output "vm_ipv6" {
  value       = module.vm.vm_ipv6
  description = "Public IPv6 of the Hetzner VM."
}

output "ssh_cmd" {
  value       = "ssh ${module.vm.ssh_user}@${module.vm.vm_ipv4}"
  description = "Convenience SSH-command to reach the VM."
}

output "domains" {
  value       = module.dns.urls
  description = "Public HTTPS URLs for the three surfaces."
}
