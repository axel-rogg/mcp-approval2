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
  name    = "Privat (Hetzner)"
}

resource "doppler_environment" "business" {
  project = doppler_project.mcp_approval2.name
  slug    = "business"
  name    = "Business (GCP - later)"
}

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
