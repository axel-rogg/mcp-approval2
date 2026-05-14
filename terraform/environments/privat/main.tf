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

# ---------------------------------------------------------------------------
# Read-only reference to the existing Cloudflare zone.
#
# WICHTIG: Wir managen die Zone NICHT in diesem Repo. Die Zone
# ai-toolhub.org wird in /workspaces/mcp-approval/terraform/ managed
# (Zone-Object, Zone-Settings, SSL/TLS, HSTS, Cert-Packs, Access-Apps,
# Rulesets etc.). Hier wird sie ausschliesslich read-only referenziert,
# damit wir nur NEUE DNS-Records fuer mcp2/knowledge2/app2 anlegen.
#
# Cross-state-Isolation:
#   - Eigener Backend-Key:   mcp-approval2/privat/terraform.tfstate
#   - Keine Resource-Blocks fuer Zone-Settings hier
#   - Reserved-Subdomain-Validation im cloudflare-dns-Modul
#   - Pre-apply-Check:       scripts/verify-terraform-isolation.sh
#
# Die Zone-ID wird weiterhin via var.cloudflare_zone_id durchgereicht
# (data-block dient hier primaer als Doku-Anker + zur Verifikation
# durch verify-terraform-isolation.sh, dass dieser Repo Zone-Settings
# NICHT managed).
# ---------------------------------------------------------------------------

data "cloudflare_zone" "ai_toolhub" {
  filter = {
    name = "ai-toolhub.org"
  }
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

# ---------------------------------------------------------------------------
# Coop-Bypass — Hetzner-Default-FQDN (Reverse-DNS-Pool, *.your-server.de).
#
# Background: Coop-Firmen-Maschine laeuft hinter einem Zscaler-Proxy, der
# `*.ai-toolhub.org` als "newly registered domain" blockt. Hetzner's
# Default-Reverse-DNS unter `static.<reversed-IP>.clients.your-server.de`
# wird durchgelassen — also exposen wir dieselben Backends zusaetzlich auf
# dieser FQDN. WebAuthn ist Origin-bound, daher braucht der Coop-Browser
# einen separaten Passkey (siehe Runbook).
# ---------------------------------------------------------------------------

output "default_hetzner_fqdn_v4" {
  value       = module.vm.default_hetzner_fqdn_v4
  description = "Hetzner-default reverse-DNS FQDN — Coop-Zscaler-bypass-Pfad."
}

output "coop_bypass_url" {
  value       = "https://${module.vm.default_hetzner_fqdn_v4}"
  description = "Diese URL ist von der Coop-Firmen-Maschine erreichbar (Zscaler-Bypass via Hetzner-Default-FQDN)."
}

output "allowed_origins_csv" {
  description = "Setze auf der VM in deploy/hetzner/.env: ALLOWED_ORIGINS=<dieser Wert>. Pflicht-Liste fuer WebAuthn-Origin-Check + CORS."
  value = join(",", [
    "https://${var.domain_mcp}",
    "https://${var.domain_app}",
    "https://${module.vm.default_hetzner_fqdn_v4}",
  ])
}
