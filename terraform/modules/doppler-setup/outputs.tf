output "project_name" {
  value       = doppler_project.mcp_approval2.name
  description = "Doppler-Project-Name."
}

output "config_privat" {
  value       = doppler_environment.privat.slug
  description = "Slug des Privat-Config (= Environment-Slug)."
}

output "config_dev" {
  value       = doppler_environment.dev.slug
  description = "Slug des Dev-Config."
}

output "hetzner_vm_service_token" {
  value       = doppler_service_token.hetzner_vm.key
  sensitive   = true
  description = "Read-only Doppler-Token fuer VM. Eintragen in /opt/mcp-approval2/.doppler-token auf der VM (chmod 600)."
}

output "github_actions_service_token" {
  value       = doppler_service_token.github_actions.key
  sensitive   = true
  description = "Doppler-Token fuer GitHub Actions CI. Eintragen als GH-Repo-Secret DOPPLER_TOKEN_GHA."
}

output "doppler_dashboard_url" {
  value       = "https://dashboard.doppler.com/workplace/projects/${doppler_project.mcp_approval2.name}/configs"
  description = "Direkt-Link in die Doppler-UI fuer dieses Project."
}

output "placeholder_count" {
  value       = 31
  description = "Anzahl der angelegten Secret-Placeholders (User muss Werte in Doppler-UI eintragen)."
}
