# ============================================================================
# Doppler Project + Environments + Secret-Placeholders
# ============================================================================
#
# Was Terraform hier anlegt:
#   - 1 Doppler-Project (Single-Source-of-Truth fuer alle Secrets)
#   - 3 Environments / Configs: dev, privat, business
#   - 24 Secret-Placeholders (leer; User traegt Werte in Doppler-UI ein)
#
# Wichtig: alle Placeholders haben `lifecycle.ignore_changes = [value]`.
# Damit ueberschreibt Terraform NIE einen vom User eingetragenen Wert.
# Der initiale Apply legt das Secret mit leerem Wert (oder sinnvollem
# Default) an — danach gehoert das Feld dem User in der Doppler-UI.
# ============================================================================

resource "doppler_project" "mcp_approval2" {
  name        = var.project_name
  description = var.project_description
}

# ---------------------------------------------------------------------------
# Environments
# ---------------------------------------------------------------------------
# Doppler-Terminologie: ein `environment` ist der Top-Level-Bucket (dev/stg/prd),
# und unter jedem environment liegt automatisch eine namensgleiche `config`.
# Wir nutzen jeweils 1 Config pro Environment direkt (kein Branch-Config).

resource "doppler_environment" "dev" {
  project = doppler_project.mcp_approval2.name
  slug    = "dev"
  name    = "Development"
}

resource "doppler_environment" "privat" {
  project = doppler_project.mcp_approval2.name
  slug    = "privat"
  name    = "Privat Hetzner"
}

# business-Environment entfernt — Credentials werden NICHT in Doppler gespeichert
# (User-Decision 2026-05-14). Wenn GCP-Phase startet: separater Workflow.

# ---------------------------------------------------------------------------
# Secret-Placeholders im "privat"-Config
# ---------------------------------------------------------------------------
# Pattern: name+leerer-value -> sichtbar in Doppler-UI -> User traegt Wert ein.
# ignore_changes = [value] stellt sicher dass Terraform den vom User
# eingetragenen Wert NICHT mehr ueberschreibt.

# ---- Cloud-Provider-Tokens (Infra) ----------------------------------------

resource "doppler_secret" "placeholder_hcloud" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "HCLOUD_TOKEN"
  value   = "" # User traegt manuell ein

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_cf_api_token" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "CLOUDFLARE_API_TOKEN"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_cf_zone_id" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "CLOUDFLARE_ZONE_ID"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_cf_account_id" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "CLOUDFLARE_ACCOUNT_ID"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_aws_access_key" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "AWS_ACCESS_KEY_ID"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_aws_secret_key" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "AWS_SECRET_ACCESS_KEY"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_r2_endpoint" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "R2_ENDPOINT"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_github_token" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "GITHUB_TOKEN"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

# ---- Google OAuth (User-Login, nicht Workspace-Tools) ---------------------

resource "doppler_secret" "placeholder_google_oauth_id" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "GOOGLE_OAUTH_CLIENT_ID"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_google_oauth_secret" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "GOOGLE_OAUTH_CLIENT_SECRET"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

# ---- SSH-Keys (Hetzner-VM-Access + GH-Actions-Deploy) ---------------------

resource "doppler_secret" "placeholder_operator_ssh_key" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "OPERATOR_SSH_PUBLIC_KEY"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_hetzner_deploy_ssh" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "HETZNER_DEPLOY_SSH_PRIVATE_KEY"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

# ---- Vertex AI (optional, fuer LLM-Calls via GCP) -------------------------

resource "doppler_secret" "placeholder_vertex_project_id" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "VERTEX_AI_PROJECT_ID"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_vertex_region" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "VERTEX_AI_REGION"
  value   = "europe-west4" # sensible default

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_vertex_sa_json" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "VERTEX_SERVICE_ACCOUNT_JSON_B64"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

# ---- VAPID (Web-Push-Notifications) ---------------------------------------

resource "doppler_secret" "placeholder_vapid_public" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "VAPID_PUBLIC_KEY"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_vapid_private" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "VAPID_PRIVATE_KEY"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

# ---- Generated-on-VM-Secrets ----------------------------------------------
# Diese Secrets werden auf der VM via setup.sh erzeugt (openssl rand, JWT-
# Keygen, etc.). Der User kopiert sie NACH dem ersten Setup in Doppler.
# Placeholders helfen zu sehen WAS einzutragen ist.

resource "doppler_secret" "placeholder_mcp_internal_token" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "MCP_APPROVAL_INTERNAL_TOKEN"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_postgres_password" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "POSTGRES_PASSWORD"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_vault_token" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "VAULT_TOKEN"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_jwt_secret" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "JWT_SECRET"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_master_key_b64" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "MASTER_KEY_BASE64"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_jwt_private_pem" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "JWT_RS256_PRIVATE_KEY_PEM"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_jwt_public_pem" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "JWT_RS256_PUBLIC_KEY_PEM"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_jwt_kid" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "JWT_KID"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_knowledge_backup_key" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "KNOWLEDGE_BACKUP_MASTER_KEY_BASE64"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_acme_email" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "ACME_EMAIL"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

# ---- Domain-Config (sinnvolle Defaults) -----------------------------------

resource "doppler_secret" "placeholder_domain_mcp" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "DOMAIN_MCP"
  value   = "mcp2.ai-toolhub.org"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_domain_knowledge" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "DOMAIN_KNOWLEDGE"
  value   = "knowledge2.ai-toolhub.org"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_domain_app" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "DOMAIN_APP"
  value   = "app2.ai-toolhub.org"

  lifecycle {
    ignore_changes = [value]
  }
}

# ---- Coop-Bypass + Origins (aus terraform output nach apply) --------------

resource "doppler_secret" "placeholder_hetzner_fqdn" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "HETZNER_FQDN_V4"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_allowed_origins" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "ALLOWED_ORIGINS"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

# ALLOWED_EMAILS: Whitelist von Google-OAuth-Login-Berechtigten.
# Server lehnt OAuth-Callbacks von nicht-gelisteten Emails ab (defense-in-depth
# zur Google-OAuth-Test-Users-Liste in der GCP-Console).
# Format: CSV (axelrogg@gmail.com,user2@gmail.com)
resource "doppler_secret" "placeholder_allowed_emails" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "ALLOWED_EMAILS"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

# ---- Fly.io Placeholders (Stand 2026-05-17, Fly-Switch) -------------------
#
# Diese Placeholders werden ergänzend zu den existing Crypto-Secrets benötigt
# wenn der privat-Mode auf Fly.io deployed wird. Workflow:
#   1. terraform apply (Buckets in r2-blob.tf + diese Placeholders)
#   2. CF-Dashboard: API-Tokens für data-Bucket + backup-Bucket erstellen
#   3. Doppler-UI: BLOB_ACCESS_KEY/SECRET + BACKUP_ACCESS_KEY/SECRET füllen
#   4. bash deploy/fly/deploy.sh — synct Doppler → fly secrets
#
# Spec: docs/privat.md §6

# Fly-API-Token (für deploy.sh + GH-Actions deploy-fly.yml)
# Mint via `fly tokens create deploy` (oder `fly auth token` für Pilot).
resource "doppler_secret" "placeholder_fly_api_token" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "FLY_API_TOKEN"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

# Cross-Service-Bridge zu mcp-knowledge2 (OBO-Pfad, gleicher Wert in beiden
# Doppler-Projects mcp-approval2/privat und mcp-knowledge2/privat).
resource "doppler_secret" "placeholder_service_token" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "SERVICE_TOKEN"
  value   = ""

  lifecycle {
    ignore_changes = [value]
  }
}

# knowledge2-Backend-URL für approval2's KC-Proxy + kc_wrappers
resource "doppler_secret" "placeholder_mcp_knowledge_url" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "MCP_KNOWLEDGE_URL"
  value   = "https://knowledge2.ai-toolhub.org"

  lifecycle {
    ignore_changes = [value]
  }
}

# OBO-Token-Issuer für Service-to-Service-JWTs (gleicher Wert wie BASE_URL).
resource "doppler_secret" "placeholder_self_oauth_issuer" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "SELF_OAUTH_ISSUER"
  value   = "https://mcp2.ai-toolhub.org"

  lifecycle {
    ignore_changes = [value]
  }
}

# ---- Blob-Provider (R2 via S3-API, privat.md §9.1) ------------------------
# Output von r2-blob.tf gibt die Bucket-Namen vor, hier Placeholders für die
# Auth-Credentials + Endpoint. R2-API-Tokens sind out-of-band (CF-Dashboard
# erstellt sie, da CF-Provider noch kein R2-API-Token-Resource hat).

resource "doppler_secret" "placeholder_blob_endpoint" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "BLOB_ENDPOINT"
  value   = "" # Format: https://<cf-account-id>.r2.cloudflarestorage.com
  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_blob_region" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "BLOB_REGION"
  value   = "auto"
  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_blob_bucket" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "BLOB_BUCKET"
  value   = "mcp-approval2-blob-eu"
  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_blob_access_key" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "BLOB_ACCESS_KEY"
  value   = "" # CF-Dashboard → R2 → API-Token mit data-bucket scope
  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_blob_secret_key" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "BLOB_SECRET_KEY"
  value   = ""
  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_blob_path_style" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "BLOB_PATH_STYLE"
  value   = "true"
  lifecycle {
    ignore_changes = [value]
  }
}

# ---- Backup-Bucket (separate API-Token, privat.md §9.2) -------------------

resource "doppler_secret" "placeholder_backup_bucket" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "BACKUP_BUCKET"
  value   = "mcp-approval2-backup-eu"
  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_backup_access_key" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "BACKUP_ACCESS_KEY"
  value   = "" # CF-Dashboard → R2 → API-Token mit nur PutObject+GetObject (kein Delete!)
  lifecycle {
    ignore_changes = [value]
  }
}

resource "doppler_secret" "placeholder_backup_secret_key" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "BACKUP_SECRET_KEY"
  value   = ""
  lifecycle {
    ignore_changes = [value]
  }
}

# Backup-Master-Key — AES-256-GCM-Key (32 bytes base64) für encrypted pg_dump.
# Generieren: openssl rand -base64 32. Pro Service unique (privat.md §4).
resource "doppler_secret" "placeholder_backup_master_key" {
  project = doppler_project.mcp_approval2.name
  config  = doppler_environment.privat.slug
  name    = "BACKUP_MASTER_KEY"
  value   = ""
  lifecycle {
    ignore_changes = [value]
  }
}
