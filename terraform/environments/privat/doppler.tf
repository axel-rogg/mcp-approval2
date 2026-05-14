# ============================================================================
# Doppler — Single-Source-of-Truth fuer alle App-Secrets
# ============================================================================
#
# Voraussetzung vor `terraform plan/apply`:
#   export DOPPLER_TOKEN=dp.pt.xxxxxxxx   (Personal-Token, workplace:admin)
# Oder via /workspaces/mcp-approval2/.dev.vars sourcen.
#
# Was hier passiert:
#   - Doppler-Project + 3 Configs (dev/privat/business) anlegen
#   - 30 Secret-Placeholders im Config "privat" anlegen (leer)
#   - 2 read-only Service-Tokens (VM + GH-Actions)
#
# Nach apply:
#   1. `terraform output doppler_dashboard` -> URL oeffnen
#   2. Alle 30 Placeholders in der Doppler-UI mit Werten fuellen
#   3. `terraform output -raw doppler_vm_token` -> auf VM in
#      /opt/mcp-approval2/.doppler-token deployen (chmod 600)
#   4. `terraform output -raw doppler_gha_token` -> als GH-Repo-Secret
#      `DOPPLER_TOKEN_GHA` setzen (`gh secret set ...`)
# ============================================================================

provider "doppler" {
  # Reads DOPPLER_TOKEN from env automatically.
}

module "doppler" {
  source = "../../modules/doppler-setup"

  project_name        = "mcp-approval2"
  project_description = "Multi-User MCP-Approval-Server (Hetzner-Pilot)"
}

# ---------------------------------------------------------------------------
# Sensitive Outputs — pipen via `terraform output -raw <name> | …`
# ---------------------------------------------------------------------------

output "doppler_vm_token" {
  value       = module.doppler.hetzner_vm_service_token
  sensitive   = true
  description = "Auf VM eintragen: terraform output -raw doppler_vm_token | ssh operator@<ip> 'sudo tee /opt/mcp-approval2/.doppler-token && sudo chmod 600 /opt/mcp-approval2/.doppler-token'."
}

output "doppler_gha_token" {
  value       = module.doppler.github_actions_service_token
  sensitive   = true
  description = "GH-Repo-Secret: terraform output -raw doppler_gha_token | gh secret set DOPPLER_TOKEN_GHA -R axel-rogg/mcp-approval2."
}

output "doppler_dashboard" {
  value       = module.doppler.doppler_dashboard_url
  description = "Doppler-UI fuer Secret-Pflege (alle 30 Placeholders mit Werten fuellen)."
}

output "doppler_project" {
  value       = module.doppler.project_name
  description = "Doppler-Project-Name (fuer doppler-CLI: `doppler setup --project <name> --config privat`)."
}
