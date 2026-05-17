# ============================================================================
# Neon Postgres — mcp-knowledge2 (privat-Mode, pgvector-enabled)
# ============================================================================
#
# Decision 2026-05-17: Fly Managed Postgres ist mit $38/mo (Basic) für Solo-
# Pilot überdimensioniert. Neon Free Tier (0,5 GB Storage, pgvector built-in,
# EU-Region Frankfurt) kostet 0 €/mo und reicht jahrelang.
#
# Architektur:
#   - 1 Neon-Project pro Service (Crypto-Boundary, Schema-Isolation, DSGVO)
#   - pgvector ist standardmäßig im "extensions"-Schema verfügbar auf Neon
#   - Knowledge-App connectet via Pooled-Endpoint (PGBouncer auto-managed)
#   - DB-Migrations + Admin-Operations via Direct-Endpoint
#
# Provider-Auth: NEON_API_KEY env-var (gesetzt vom doppler-run-terraform.sh
# Wrapper aus Doppler approval2/fly).
# ============================================================================

provider "neon" {
  # Liest NEON_API_KEY aus der Umgebung — keine explicit-arg, damit der
  # Token nicht im State landet.
}

# ---------------------------------------------------------------------------
# Project — mcp-knowledge2
# ---------------------------------------------------------------------------

resource "neon_project" "knowledge2" {
  name       = "mcp-knowledge2"
  region_id  = "aws-eu-central-1" # Frankfurt — DSGVO + Latenz zu Fly-fra
  pg_version = 16

  # Free-Tier-Limits (Neon-API enforced):
  #   - compute: plan-fixed (0.25 CU shared, no autoscaling, no custom suspend)
  #   - history_retention: max 6h (21600s) — provider default 24h würde reject werden
  history_retention_seconds = 21600
}

# ---------------------------------------------------------------------------
# Database — knowledge2
# ---------------------------------------------------------------------------
#
# Neon legt automatisch eine Default-DB `neondb` an. Wir benennen sie hier
# um auf `mcp_knowledge2` für Konsistenz mit der App-Konvention (matched
# DATABASE_URL-Suffix die in app/db/client.ts erwartet wird).

resource "neon_database" "knowledge2" {
  project_id = neon_project.knowledge2.id
  branch_id  = neon_project.knowledge2.default_branch_id
  name       = "mcp_knowledge2"
  owner_name = neon_role.knowledge2_app.name
}

# ---------------------------------------------------------------------------
# Roles — app + admin
# ---------------------------------------------------------------------------
#
# Zwei Roles entsprechend dem App-Pattern:
#   - knowledge_app:    standard-User für App-Operationen (RLS-bounded)
#   - knowledge_admin:  BYPASSRLS für cross-user Operations (Backup, GDPR-Erase)
#
# Neon erlaubt CREATE ROLE im SQL nach Connection — aber via TF ist es
# sauberer + die Passwords landen direkt im State (für Doppler-Push) anstatt
# aus interaktivem SQL-Output extrahiert werden zu müssen.

resource "neon_role" "knowledge2_app" {
  project_id = neon_project.knowledge2.id
  branch_id  = neon_project.knowledge2.default_branch_id
  name       = "knowledge_app"
}

resource "neon_role" "knowledge2_admin" {
  project_id = neon_project.knowledge2.id
  branch_id  = neon_project.knowledge2.default_branch_id
  name       = "knowledge_admin"
}

# ---------------------------------------------------------------------------
# Doppler-Push — Connection-Strings + Credentials direkt in Doppler/fly
# ---------------------------------------------------------------------------
#
# Pooled-Connection-String wird zu DATABASE_URL (für die App).
# Direct-Connection-String mit knowledge_admin zu DATABASE_ADMIN_URL.
#
# Beide Pattern matchen die Doppler-Keys die deploy/fly/sync-secrets.sh
# erwartet — kein App-Code-Change nötig.

locals {
  # neon_project exposes database_host / database_host_pooler directly (the real
  # ep-<name>.<region>.aws.neon.tech pattern). Avoids the broken branch_id-based
  # construction which produces DNS-unresolvable hostnames.
  knowledge2_pooled_host = neon_project.knowledge2.database_host_pooler
  knowledge2_direct_host = neon_project.knowledge2.database_host
  knowledge2_db_name     = neon_database.knowledge2.name
}

resource "doppler_secret" "knowledge2_database_url_fly" {
  project = "mcp-knowledge2"
  config  = "fly"
  name    = "DATABASE_URL"
  value   = "postgresql://${neon_role.knowledge2_app.name}:${neon_role.knowledge2_app.password}@${local.knowledge2_pooled_host}/${local.knowledge2_db_name}?sslmode=require"
}

resource "doppler_secret" "knowledge2_database_admin_url_fly" {
  project = "mcp-knowledge2"
  config  = "fly"
  name    = "DATABASE_ADMIN_URL"
  value   = "postgresql://${neon_role.knowledge2_admin.name}:${neon_role.knowledge2_admin.password}@${local.knowledge2_direct_host}/${local.knowledge2_db_name}?sslmode=require"
}

# Plus rückwärtskompatibel: einige Skripte erwarten DB_APP_PASSWORD/DB_ADMIN_PASSWORD
# als separate Keys (z.B. für SQL-Bootstrap). Wir pushen sie der Vollständigkeit halber.
resource "doppler_secret" "knowledge2_db_app_password_fly" {
  project = "mcp-knowledge2"
  config  = "fly"
  name    = "DB_APP_PASSWORD"
  value   = neon_role.knowledge2_app.password
}

resource "doppler_secret" "knowledge2_db_admin_password_fly" {
  project = "mcp-knowledge2"
  config  = "fly"
  name    = "DB_ADMIN_PASSWORD"
  value   = neon_role.knowledge2_admin.password
}

# ---------------------------------------------------------------------------
# Outputs — für Operator-Verifikation + andere Module
# ---------------------------------------------------------------------------

output "knowledge2_neon_project_id" {
  value       = neon_project.knowledge2.id
  description = "Neon-Project-ID für mcp-knowledge2 (für CLI-Operationen + Dashboard-Links)."
}

output "knowledge2_neon_pooled_host" {
  value       = local.knowledge2_pooled_host
  description = "Pooled-Endpoint-Host (über PGBouncer, für App-Connections)."
}

output "knowledge2_neon_dashboard" {
  value       = "https://console.neon.tech/app/projects/${neon_project.knowledge2.id}"
  description = "Direkt-Link zum Neon-Dashboard für das knowledge2-Project."
}
