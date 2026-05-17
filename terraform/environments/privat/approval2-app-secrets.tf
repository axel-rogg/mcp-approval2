# ============================================================================
# mcp-approval2 — App-Layer Secrets (Phase A+B Security-Audit-Fixes)
# ============================================================================
#
# Phase A+B (SECURITY_ISSUES.md, 2026-05-17) hat 3 neue Operator-Knobs
# eingefuehrt die fuer den Pilot-Open gesetzt sein muessen. Wir verwalten sie
# hier in TF damit:
#   - der Wert auditierbar ist (PR-Diff statt UI-Klick)
#   - rotation/rollback via TF state moeglich ist
#   - Cross-Repo-Doku (siehe SECURITY_ISSUES.md) konsistent bleibt
#
# Nach `terraform apply` schreibt der Doppler-Provider die Werte ins
# `mcp-approval2 / fly` Config. Fly liest die Werte NICHT auto-sync —
# Operator muss `fly secrets set ...` laufen lassen oder beim naechsten
# deploy via deploy/fly/deploy.sh.
# ============================================================================

# SEC-008: Bootstrap-Admin-Email. Wenn ungesetzt, gilt alter
# "first-to-login wird admin"-Pfad mit console.warn — anfaellig gegen
# Race-Attacks zwischen Deploy-T+0 und erstem Operator-Login.
resource "doppler_secret" "approval2_bootstrap_admin_email_fly" {
  project = "mcp-approval2"
  config  = "fly"
  name    = "BOOTSTRAP_ADMIN_EMAIL"
  value   = "axelrogg@gmail.com"
}

# SEC-005: DCR-Gating. Default fail-closed — POST /oauth/register lehnt
# Calls ohne DCR_INITIAL_ACCESS_TOKEN ODER logged-in-Session ab. Ein
# expliziter "false"-String macht das im Doppler-Diff visible.
resource "doppler_secret" "approval2_dcr_open_fly" {
  project = "mcp-approval2"
  config  = "fly"
  name    = "DCR_OPEN"
  value   = "false"
}

# SEC-005: Initial-Access-Token (RFC 7591 §3) fuer MCP-Clients die ihre
# DCR-Registration nicht aus einem Browser-Login machen koennen
# (z.B. Claude.ai-Desktop). Operator gibt den Token out-of-band an die
# Whitelist-Clients weiter.
#
# random_password mit length=48 + special=false → 48 chars [a-zA-Z0-9]
# (passt zu unserem .min(32)-Schema-Check + ist URL-safe ohne escape).
resource "random_password" "approval2_dcr_initial_access_token" {
  length  = 48
  special = false
  upper   = true
  lower   = true
  numeric = true
}

resource "doppler_secret" "approval2_dcr_initial_access_token_fly" {
  project = "mcp-approval2"
  config  = "fly"
  name    = "DCR_INITIAL_ACCESS_TOKEN"
  value   = random_password.approval2_dcr_initial_access_token.result
}

# Optional: Host-Allowlist fuer redirect_uri. Leer = keine Host-Restriction
# (Scheme-Check via isAllowedRedirectUri greift weiterhin). Setzen wenn
# wir die DCR-Surface auf bekannte Clients (claude.ai etc) einengen wollen.
# Aktuell leer fuer maximale Pilot-Flexibilitaet.
resource "doppler_secret" "approval2_dcr_allowed_redirect_hosts_fly" {
  project = "mcp-approval2"
  config  = "fly"
  name    = "DCR_ALLOWED_REDIRECT_HOSTS"
  value   = ""
}

# ----------------------------------------------------------------------------
# Outputs — Operator-Helpers
# ----------------------------------------------------------------------------

output "approval2_dcr_initial_access_token" {
  description = "Sensitive: gib das an MCP-Clients die DCR machen sollen. Anzeigen via: terraform output -raw approval2_dcr_initial_access_token"
  value       = random_password.approval2_dcr_initial_access_token.result
  sensitive   = true
}
