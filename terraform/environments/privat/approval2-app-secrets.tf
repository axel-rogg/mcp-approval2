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
# Multi-User Tier 1 (2026-05-17) — Email-Versand fuer Invite + Recovery
# ----------------------------------------------------------------------------
#
# Default `console`: Mails landen in der `email_outbox`-DB-Tabelle, Operator
# sieht sie im PWA-Admin-Tab "Outbox" + stellt manuell zu (Signal/iMessage).
# Sinnvoll fuer 2-3-Tester-Pilot solange Resend-DNS-Verify pending ist.
#
# Switch zu Resend:
#   1. Bei resend.com signup, Domain `ai-toolhub.org` hinzufuegen.
#   2. Resend zeigt 3 DNS-Records (DKIM `resend._domainkey`, SPF, optional
#      DMARC) — diese in CF via terraform/environments/privat/cloudflare-*.tf
#      einpflegen (Resend-Domain-TF-Modul existiert nicht; manuell als
#      cloudflare_record-Resourcen).
#   3. RESEND_API_KEY-Wert hier ueberschreiben (Doppler-UI ODER hier den
#      value-Block ersetzen).
#   4. EMAIL_PROVIDER value von "console" auf "resend" flippen.
#   5. terraform apply + `fly secrets set` redeploy.

resource "doppler_secret" "approval2_email_provider_fly" {
  project = "mcp-approval2"
  config  = "fly"
  name    = "EMAIL_PROVIDER"
  value   = "console"
}

resource "doppler_secret" "approval2_email_from_fly" {
  project = "mcp-approval2"
  config  = "fly"
  name    = "EMAIL_FROM"
  value   = "mcp-approval2 <noreply@ai-toolhub.org>"
}

# Placeholder — Operator setzt den echten Resend-API-Key out-of-band.
# Wir koennen ihn hier nicht generieren weil Resend kein TF-Provider hat.
# Der min(8)-Check im Schema akzeptiert auch unsere Platzhalter-String
# damit Boot nicht stirbt; wenn EMAIL_PROVIDER=console ist, wird der Wert
# eh nicht gelesen.
resource "doppler_secret" "approval2_resend_api_key_fly" {
  project = "mcp-approval2"
  config  = "fly"
  name    = "RESEND_API_KEY"
  value   = "rs_placeholder_set_via_resend_signup"
}

# ============================================================================
# Sub-MCP-Gateway Service-Tokens (Schicht-1, approval2 <-> Worker)
# ============================================================================
#
# Plan-Ref: docs/plans/active/PLAN-per-user-server-store.md
#
# Pre-shared Bearer-Tokens zwischen approval2 und den 3 CF-Worker-Sub-MCPs
# (utils/gws/gcloud). Operator-Secrets — NICHT per-user. User-level OAuth
# wandert in user_sub_mcp_config (KMS-encrypted, Phase 2).
#
# Beide Seiten muessen denselben Token sehen:
#   - approval2: SUB_MCP_TOKEN_<NAME> aus Doppler-mcp-approval2/fly
#   - Worker:    SERVICE_TOKEN aus Doppler-mcp-<name>/cloudflare (separater TF)
#
# Diese random_password-Resources sind die Single-Source-of-Truth.
# Outputs unten exposen die plain-Werte fuer Cross-Repo-TF
# (terraform_remote_state) ODER fuer einmaliges Copy-Paste.
#
# Rotation: terraform taint random_password.sub_mcp_token_<name> + apply.
# Beide Seiten muessen dann neu deployed werden (fly fuer approval2 +
# wrangler fuer den Worker).
# ============================================================================

resource "random_password" "sub_mcp_token_utils" {
  length  = 48
  special = false
}

resource "random_password" "sub_mcp_token_gws" {
  length  = 48
  special = false
}

resource "random_password" "sub_mcp_token_gcloud" {
  length  = 48
  special = false
}

resource "doppler_secret" "approval2_sub_mcp_token_utils" {
  project = "mcp-approval2"
  config  = "fly"
  name    = "SUB_MCP_TOKEN_UTILS"
  value   = random_password.sub_mcp_token_utils.result
}

resource "doppler_secret" "approval2_sub_mcp_token_gws" {
  project = "mcp-approval2"
  config  = "fly"
  name    = "SUB_MCP_TOKEN_GWS"
  value   = random_password.sub_mcp_token_gws.result
}

resource "doppler_secret" "approval2_sub_mcp_token_gcloud" {
  project = "mcp-approval2"
  config  = "fly"
  name    = "SUB_MCP_TOKEN_GCLOUD"
  value   = random_password.sub_mcp_token_gcloud.result
}

# ----------------------------------------------------------------------------
# Outputs — Operator-Helpers
# ----------------------------------------------------------------------------

output "approval2_dcr_initial_access_token" {
  description = "Sensitive: gib das an MCP-Clients die DCR machen sollen. Anzeigen via: terraform output -raw approval2_dcr_initial_access_token"
  value       = random_password.approval2_dcr_initial_access_token.result
  sensitive   = true
}

output "sub_mcp_token_utils" {
  description = "Sensitive: SERVICE_TOKEN fuer mcp-utils-Worker. Sync via wrangler secret put SERVICE_TOKEN."
  value       = random_password.sub_mcp_token_utils.result
  sensitive   = true
}

output "sub_mcp_token_gws" {
  description = "Sensitive: SERVICE_TOKEN fuer mcp-gws-Worker."
  value       = random_password.sub_mcp_token_gws.result
  sensitive   = true
}

output "sub_mcp_token_gcloud" {
  description = "Sensitive: SERVICE_TOKEN fuer mcp-gcloud-Worker."
  value       = random_password.sub_mcp_token_gcloud.result
  sensitive   = true
}
