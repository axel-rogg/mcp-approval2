# ============================================================================
# Neon Postgres — mcp-approval2 (privat-Mode, Standard ohne pgvector)
# ============================================================================
#
# Spiegel-Setup zu neon-knowledge2.tf, aber:
#   - **kein pgvector** (approval2 macht keine Embedding-Search)
#   - eigenes Neon-Project (Crypto-Boundary + DSGVO-Isolation gegen knowledge2)
#   - Roles `approval_app` + `approval_admin` analog zu knowledge2-Pattern
#
# Provider-Auth: NEON_API_KEY env-var (gleicher Token funktioniert für
# alle Projects im selben Neon-Account — Neon hat keine Per-Project-Token-
# Scopes wie z.B. Cloudflare R2).
# ============================================================================

# ---------------------------------------------------------------------------
# Project — mcp-approval2
# ---------------------------------------------------------------------------

resource "neon_project" "approval2" {
  name       = "mcp-approval2"
  region_id  = "aws-eu-central-1"
  pg_version = 16

  # Free-Tier-Limits — siehe neon-knowledge2.tf für Kontext.
  history_retention_seconds = 21600
}

# ---------------------------------------------------------------------------
# Database — approval2
# ---------------------------------------------------------------------------

resource "neon_database" "approval2" {
  project_id = neon_project.approval2.id
  branch_id  = neon_project.approval2.default_branch_id
  name       = "mcp_approval2"
  owner_name = neon_role.approval2_app.name
}

# ---------------------------------------------------------------------------
# Roles — approval_app + approval_admin
# ---------------------------------------------------------------------------

resource "neon_role" "approval2_app" {
  project_id = neon_project.approval2.id
  branch_id  = neon_project.approval2.default_branch_id
  name       = "approval_app"
}

resource "neon_role" "approval2_admin" {
  project_id = neon_project.approval2.id
  branch_id  = neon_project.approval2.default_branch_id
  name       = "approval_admin"
}

# ---------------------------------------------------------------------------
# Doppler-Push — Connection-Strings in mcp-approval2/fly
# ---------------------------------------------------------------------------

locals {
  # neon_project exposes database_host / database_host_pooler directly (real
  # ep-<name>.<region>.aws.neon.tech pattern — not the broken branch_id construct).
  approval2_pooled_host = neon_project.approval2.database_host_pooler
  approval2_direct_host = neon_project.approval2.database_host
  approval2_db_name     = neon_database.approval2.name
}

resource "doppler_secret" "approval2_database_url_fly" {
  project = "mcp-approval2"
  config  = "fly"
  name    = "DATABASE_URL"
  value   = "postgresql://${neon_role.approval2_app.name}:${neon_role.approval2_app.password}@${local.approval2_pooled_host}/${local.approval2_db_name}?sslmode=require"
}

resource "doppler_secret" "approval2_database_admin_url_fly" {
  project = "mcp-approval2"
  config  = "fly"
  name    = "DATABASE_ADMIN_URL"
  value   = "postgresql://${neon_role.approval2_admin.name}:${neon_role.approval2_admin.password}@${local.approval2_direct_host}/${local.approval2_db_name}?sslmode=require"
}

resource "doppler_secret" "approval2_db_app_password_fly" {
  project = "mcp-approval2"
  config  = "fly"
  name    = "DB_APP_PASSWORD"
  value   = neon_role.approval2_app.password
}

resource "doppler_secret" "approval2_db_admin_password_fly" {
  project = "mcp-approval2"
  config  = "fly"
  name    = "DB_ADMIN_PASSWORD"
  value   = neon_role.approval2_admin.password
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "approval2_neon_project_id" {
  value       = neon_project.approval2.id
  description = "Neon-Project-ID für mcp-approval2."
}

output "approval2_neon_pooled_host" {
  value       = local.approval2_pooled_host
  description = "Pooled-Endpoint-Host (PGBouncer)."
}

output "approval2_neon_dashboard" {
  value       = "https://console.neon.tech/app/projects/${neon_project.approval2.id}"
  description = "Direkt-Link zum Neon-Dashboard."
}
