# ============================================================================
# Service-Tokens
# ============================================================================
#
# Service-Tokens sind read-only (access="read") Doppler-CLI-Tokens, gebunden
# an einen einzelnen Config. Damit kann ein Server / CI-Job NUR die Secrets
# DIESES Configs lesen — kein Workplace-Admin-Scope.
#
# Wir legen 2 separate Tokens an, damit ein Rotate auf einer Seite nicht
# die andere bricht:
#   1. hetzner-vm-readonly   -> auf der VM in /opt/mcp-approval2/.doppler-token
#   2. github-actions-readonly -> als GH-Repo-Secret DOPPLER_TOKEN_GHA
# ============================================================================

resource "doppler_service_token" "hetzner_vm" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "hetzner-vm-readonly"
  access  = "read"
}

resource "doppler_service_token" "github_actions" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "github-actions-readonly"
  access  = "read"
}
