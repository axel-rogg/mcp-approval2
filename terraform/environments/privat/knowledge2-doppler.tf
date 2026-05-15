# ============================================================================
# Doppler — mcp-knowledge2 Project Setup
# ============================================================================
#
# Schwester-Project zu mcp-approval2 (siehe doppler.tf). Eigenes Doppler-
# Project + 2 Configs (dev, privat). Service-Tokens fuer VM und GH-Actions.
#
# Voraussetzung vor `terraform plan/apply`:
#   export DOPPLER_TOKEN=dp.pt.xxxxxxxx   (Personal-Token, workplace:admin)
#
# Was hier passiert:
#   1. Doppler-Project `mcp-knowledge2` + 2 Configs (dev/privat)
#   2. ~28 Secret-Placeholders im "privat"-Config (leer)
#   3. Dev-Convention-Werte im "dev"-Config (vorgefuellt fuer lokale Compose)
#   4. 2 read-only Service-Tokens (VM + GH-Actions)
#
# Nach apply:
#   1. `terraform output knowledge2_doppler_dashboard` → URL oeffnen
#   2. Im privat-Config alle externen Secrets befuellen:
#      - GOOGLE_OAUTH_CLIENT_ID (aus Google Cloud Console)
#      - GOOGLE_OAUTH_CLIENT_SECRET
#      - VERTEX_PROJECT (GCP-Project-ID)
#      - DB_APP_PASSWORD, DB_ADMIN_PASSWORD (oder via VM-setup.sh generieren)
#      - BLOB_ACCESS_KEY, BLOB_SECRET_KEY (Hetzner Object Storage)
#      - OPENBAO_TOKEN (aus VM-setup)
#      - SERVICE_TOKEN, KMS_MASTER_KEY_B64, BACKUP_MASTER_KEY (generieren via
#        `scripts/seed-doppler-knowledge2-dev.sh` fuer dev — privat manuell)
#   3. Fuer dev: `bash scripts/seed-doppler-knowledge2-dev.sh` ausfuehren
#      (generiert SERVICE_TOKEN + KMS_MASTER_KEY_B64 + BACKUP_MASTER_KEY mit
#      openssl rand und schreibt sie in den dev-Config — fuer lokale
#      docker-compose-Sessions)
#   4. `terraform output -raw knowledge2_doppler_vm_token` auf VM in
#      /opt/mcp-knowledge2/.doppler-token deployen (chmod 600)
#   5. `terraform output -raw knowledge2_doppler_gha_token` als GH-Repo-Secret
#      `DOPPLER_TOKEN_GHA` fuer axel-rogg/mcp-knowledge2 setzen
# ============================================================================

# ---------------------------------------------------------------------------
# Project + Environments
# ---------------------------------------------------------------------------

resource "doppler_project" "knowledge2" {
  name        = "mcp-knowledge2"
  description = "Multi-User Knowledge-Service (Hetzner-Pilot, Schwester zu mcp-approval2)"
}

resource "doppler_environment" "knowledge2_dev" {
  project = doppler_project.knowledge2.name
  slug    = "dev"
  name    = "Development"
}

resource "doppler_environment" "knowledge2_privat" {
  project = doppler_project.knowledge2.name
  slug    = "privat"
  name    = "Privat Hetzner"
}

# ===========================================================================
# Trivial-Defaults — gleich in beiden Configs (App-Tuning, kein Secret)
# ===========================================================================

locals {
  # Werte die in beiden Configs identisch sind (Tuning-Knobs, keine Secrets).
  knowledge2_trivial_both = {
    PORT                   = "8080"
    LOG_LEVEL              = "info"
    DATABASE_POOL_MAX      = "20"
    JWKS_CACHE_TTL_SECONDS = "86400"
    GOOGLE_HD_ALLOWLIST    = ""
    GOOGLE_JWKS_URL        = "https://www.googleapis.com/oauth2/v3/certs"
    GOOGLE_ISSUER          = "https://accounts.google.com"
    MCP_APPROVAL_ISSUER    = "mcp-approval2"
    BLOB_REGION            = "eu-central"
    BLOB_PATH_STYLE        = "true"
    # Embedding-Provider-Defaults (Wechsel zu Cloudflare Workers AI via AI Gateway)
    EMBED_PROVIDER         = "cloudflare"
    CLOUDFLARE_AI_MODEL    = "@cf/baai/bge-m3"
    # Wiederverwendung des existing AI Gateways aus mcp-approval (Quality-Gate).
    # AI Gateways sind provider-agnostisch — ein Gateway kann Workers AI + Google AI Studio + … parallel routen.
    CLOUDFLARE_AI_GATEWAY_ID = "mcp-approval-quality"
    # Vertex bleibt verfügbar als Fallback; nur aktiv wenn EMBED_PROVIDER=vertex
    VERTEX_LOCATION        = "europe-west4"
    VERTEX_MODEL           = "text-multilingual-embedding-002"
    OPENBAO_TRANSIT_PATH   = "transit"
    BACKUP_RETENTION_DAYS  = "30"
  }
}

resource "doppler_secret" "knowledge2_trivial_dev" {
  for_each = local.knowledge2_trivial_both

  project = doppler_project.knowledge2.name
  config  = doppler_environment.knowledge2_dev.slug
  name    = each.key
  value   = each.value
}

resource "doppler_secret" "knowledge2_trivial_privat" {
  for_each = local.knowledge2_trivial_both

  project = doppler_project.knowledge2.name
  config  = doppler_environment.knowledge2_privat.slug
  name    = each.key
  value   = each.value
}

# NODE_ENV: per Config unterschiedlich
resource "doppler_secret" "knowledge2_node_env_dev" {
  project = doppler_project.knowledge2.name
  config  = doppler_environment.knowledge2_dev.slug
  name    = "NODE_ENV"
  value   = "development"
}

resource "doppler_secret" "knowledge2_node_env_privat" {
  project = doppler_project.knowledge2.name
  config  = doppler_environment.knowledge2_privat.slug
  name    = "NODE_ENV"
  value   = "production"
}

# ===========================================================================
# Dev-Convention-Werte — sinnvolle Defaults fuer docker-compose.dev.yml
# Im privat-Config bleiben sie leere Placeholders.
# ===========================================================================

locals {
  knowledge2_dev_conventions = {
    # DB (compose-internal: service-name "postgres", port 5432)
    DATABASE_URL          = "postgres://knowledge_app:devpassword@postgres:5432/knowledge"
    DATABASE_ADMIN_URL    = "postgres://knowledge_admin:adminpassword@postgres:5432/knowledge"
    DB_APP_PASSWORD       = "devpassword"
    DB_ADMIN_PASSWORD     = "adminpassword"

    # OAuth (dev: localhost; prod: knowledge2.ai-toolhub.org)
    SELF_OAUTH_ISSUER         = "http://localhost:8080"
    GOOGLE_OAUTH_REDIRECT_URI = "http://localhost:8080/auth/google/callback"

    # Blob (compose-internal MinIO)
    BLOB_ENDPOINT   = "http://minio:9000"
    BLOB_ACCESS_KEY = "minioroot"
    BLOB_SECRET_KEY = "minioroot12345"
    BLOB_BUCKET     = "knowledge"
    BACKUP_BUCKET   = "knowledge-backup"

    # KMS (dev: hkdf_local — kein OpenBao noetig)
    KMS_PROVIDER = "hkdf_local"

    # Vertex (dev: leer; macht im Code nichts wenn nicht gesetzt)
    VERTEX_SERVICE_ACCOUNT_JSON_PATH = "/etc/secrets/vertex-sa.json"

    # Domain (dev hat keine eigene Domain)
    DOMAIN_KNOWLEDGE = "knowledge2.ai-toolhub.org"
  }
}

resource "doppler_secret" "knowledge2_dev_convention" {
  for_each = local.knowledge2_dev_conventions

  project = doppler_project.knowledge2.name
  config  = doppler_environment.knowledge2_dev.slug
  name    = each.key
  value   = each.value

  # User darf dev-Werte ueberschreiben (z.B. eigenes Test-DB-Password) — wir
  # halten den Initialwert nicht hart.
  lifecycle {
    ignore_changes = [value]
  }
}

# ===========================================================================
# Placeholders im privat-Config — alle Secrets die manuell zu fuellen sind
# ===========================================================================

locals {
  knowledge2_privat_placeholders = toset([
    # OAuth (external, aus Google Cloud Console)
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_REDIRECT_URI",
    "SELF_OAUTH_ISSUER",

    # Cross-Service
    "SERVICE_TOKEN", # shared mit approval2
    "MCP_APPROVAL_JWKS_URL", # optional, fuer OBO-Mode

    # DB-Passwords (generiert via VM-setup.sh; oder hier eintragen wenn extern)
    "DB_APP_PASSWORD",
    "DB_ADMIN_PASSWORD",
    "DATABASE_URL",
    "DATABASE_ADMIN_URL",

    # Blob (Hetzner Object Storage Production-Creds)
    "BLOB_ENDPOINT",
    "BLOB_ACCESS_KEY",
    "BLOB_SECRET_KEY",
    "BLOB_BUCKET",
    "BACKUP_BUCKET",

    # Cloudflare Workers AI (Embedding-Provider, EMBED_PROVIDER=cloudflare)
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    # Optional: nur bei AI Gateway "Authenticated Mode" — eigener gateway-scoped Token
    "CLOUDFLARE_AI_GATEWAY_TOKEN",

    # Vertex AI (Legacy-Fallback, nur wenn EMBED_PROVIDER=vertex)
    "VERTEX_PROJECT",
    "VERTEX_SERVICE_ACCOUNT_JSON_PATH",

    # KMS (prod: openbao)
    "KMS_PROVIDER", # "openbao" in prod (default "hkdf_local")
    "OPENBAO_ADDR",
    "OPENBAO_TOKEN",
    "KMS_MASTER_KEY_B64", # only if hkdf_local fallback

    # Crypto (generiert)
    "BACKUP_MASTER_KEY",

    # Domain + Access
    "DOMAIN_KNOWLEDGE",
    "ALLOWED_ORIGINS",
    "ALLOWED_EMAILS",
  ])
}

resource "doppler_secret" "knowledge2_placeholder_privat" {
  for_each = local.knowledge2_privat_placeholders

  project = doppler_project.knowledge2.name
  config  = doppler_environment.knowledge2_privat.slug
  name    = each.value
  value   = "" # User traegt manuell ein

  lifecycle {
    ignore_changes = [value]
  }
}

# ===========================================================================
# External-Secrets-Placeholders im dev-Config (Google-OAuth + Vertex)
# Diese MUSS der User auch im dev eintragen wenn er Google-OAuth-Flow testen will.
# ===========================================================================

locals {
  knowledge2_dev_externals = toset([
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "CLOUDFLARE_ACCOUNT_ID",        # leer ok, nur fuer Embed-Tests gebraucht
    "CLOUDFLARE_API_TOKEN",         # leer ok, nur fuer Embed-Tests gebraucht
    "CLOUDFLARE_AI_GATEWAY_TOKEN",  # leer ok, nur bei Authenticated Gateway gebraucht
    "VERTEX_PROJECT",               # leer ok, Vertex-Fallback nur wenn EMBED_PROVIDER=vertex
    "MCP_APPROVAL_JWKS_URL",     # leer ok, nur fuer OBO-Tests
  ])
}

resource "doppler_secret" "knowledge2_dev_external_placeholder" {
  for_each = local.knowledge2_dev_externals

  project = doppler_project.knowledge2.name
  config  = doppler_environment.knowledge2_dev.slug
  name    = each.value
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

# ===========================================================================
# Generated-Crypto-Placeholders im dev-Config
# Werden via `bash scripts/seed-doppler-knowledge2-dev.sh` befuellt.
# ===========================================================================

locals {
  knowledge2_dev_crypto_placeholders = toset([
    "SERVICE_TOKEN",        # 32-byte hex
    "KMS_MASTER_KEY_B64",   # 32-byte base64 (fuer hkdf_local)
    "BACKUP_MASTER_KEY",    # 32-byte base64
  ])
}

resource "doppler_secret" "knowledge2_dev_crypto_placeholder" {
  for_each = local.knowledge2_dev_crypto_placeholders

  project = doppler_project.knowledge2.name
  config  = doppler_environment.knowledge2_dev.slug
  name    = each.value
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

# ---------------------------------------------------------------------------
# Service-Tokens (read-only) fuer VM und GH-Actions
# ---------------------------------------------------------------------------

resource "doppler_service_token" "knowledge2_hetzner_vm" {
  project = doppler_project.knowledge2.name
  config  = doppler_environment.knowledge2_privat.slug
  name    = "hetzner-vm-readonly"
  access  = "read"
}

resource "doppler_service_token" "knowledge2_github_actions" {
  project = doppler_project.knowledge2.name
  config  = doppler_environment.knowledge2_privat.slug
  name    = "github-actions-readonly"
  access  = "read"
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "knowledge2_doppler_vm_token" {
  value       = doppler_service_token.knowledge2_hetzner_vm.key
  sensitive   = true
  description = "Read-only Doppler-Token fuer KC2-VM. Eintragen in /opt/mcp-knowledge2/.doppler-token (chmod 600)."
}

output "knowledge2_doppler_gha_token" {
  value       = doppler_service_token.knowledge2_github_actions.key
  sensitive   = true
  description = "Doppler-Token fuer KC2 GitHub Actions. Als GH-Repo-Secret DOPPLER_TOKEN_GHA in axel-rogg/mcp-knowledge2 setzen."
}

output "knowledge2_doppler_dashboard" {
  value       = "https://dashboard.doppler.com/workplace/projects/${doppler_project.knowledge2.name}/configs"
  description = "Doppler-UI fuer KC2-Secret-Pflege (privat-Config befuellen)."
}

output "knowledge2_doppler_project" {
  value       = doppler_project.knowledge2.name
  description = "Doppler-Project-Name (fuer doppler-CLI: `doppler setup --project mcp-knowledge2 --config privat`)."
}
