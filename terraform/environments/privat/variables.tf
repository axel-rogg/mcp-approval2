# --- Cloudflare-Inputs (für CF-Zone-Data + R2-Buckets + AI-Gateway) ----------
#
# Hetzner-spezifische Inputs (hcloud_token, operator_ssh_public_key,
# allowed_ssh_ips, server_type, location, data_volume_size_gb) wurden mit
# dem Fly.io-Switch (2026-05-17) entfernt. Siehe docs/privat.md §9.4 +
# §11 für Audit-Trail. Hetzner-Module-Code bleibt unter
# terraform/modules/hetzner-mcp-instance/ als historisches Material.

variable "cloudflare_zone_id" {
  type        = string
  default     = ""
  description = "Cloudflare zone ID. Optional bei Doppler-only apply — kommt sonst via Doppler-Sync."
}

# --- Domain-Inputs (informative — Records werden via fly certs + CF manuell) ---

variable "domain_mcp" {
  type        = string
  default     = "mcp2.ai-toolhub.org"
  description = "FQDN für MCP-API surface (approval2). Custom-Domain via `fly certs add mcp2.ai-toolhub.org -a mcp-approval2` + CF-CNAME zu mcp-approval2.fly.dev."
}

variable "domain_knowledge" {
  type        = string
  default     = "knowledge2.ai-toolhub.org"
  description = "FQDN für Knowledge-Service. Custom-Domain via `fly certs add knowledge2.ai-toolhub.org -a mcp-knowledge2` + CF-CNAME zu mcp-knowledge2.fly.dev."
}

variable "domain_app" {
  type        = string
  default     = "app2.ai-toolhub.org"
  description = "FQDN für PWA surface (gleicher Fly-App wie domain_mcp, mit `fly certs add app2.ai-toolhub.org -a mcp-approval2`)."
}

# --- GitHub-Terraform inputs ------------------------------------------------
#
# These power the `github-repo` module (see github.tf). The GitHub provider
# itself reads its token from $GITHUB_TOKEN — that env-var is NOT a Terraform
# variable, just a runtime requirement.
#
# All sensitive values are gitignored via .tfvars rules — never commit
# terraform.tfvars.

variable "cloudflare_api_token" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Cloudflare API token. Optional now — kommt via Doppler-Sync nach Setup."
}

variable "cloudflare_account_id" {
  type        = string
  default     = ""
  description = "Cloudflare account ID (öffentlich, sichtbar in Dashboard-URLs). Needed for account-scoped Resources (R2, AI Gateway, Workers AI). Kommt via Doppler-Sync."
}

variable "r2_access_key_id" {
  type        = string
  sensitive   = true
  default     = ""
  description = "R2 access key. Optional now — kommt via Doppler-Sync."
}

variable "r2_secret_access_key" {
  type        = string
  sensitive   = true
  default     = ""
  description = "R2 secret key. Optional now — kommt via Doppler-Sync."
}

variable "mcp_approval_internal_token" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Internal service-token. Optional now — kommt via Doppler-Sync."
}

variable "ghcr_token" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Optional PAT with read:packages for private ghcr.io pulls. Empty string skips creation of GHCR_TOKEN."
}

# --- Fly.io inputs (used by knowledge2-fly.tf) ------------------------------
#
# Token-Quelle: `fly auth token` mintet einen User-Scope-Token, der für den
# Solo-Pilot ausreicht. Org-deploy-Tokens wären die produktive Variante
# (siehe https://fly.io/docs/security/tokens/). Der Provider liest
# FLY_API_TOKEN aus der Umgebung — also entweder vor `terraform plan/apply`
# `export FLY_API_TOKEN=$(fly auth token)` oder via doppler-run-terraform.sh
# durch Doppler-Secret `FLY_API_TOKEN` injecten. Damit landet der Token
# nicht im State.

variable "fly_org" {
  type        = string
  default     = "personal"
  description = "Fly.io org slug. `personal` für Free-Tier-Accounts. Bei Paid-Accounts der named-org-slug aus `fly orgs list`."
}

# --- GCP-Inputs (für Cloud-KMS-KEK-Path) ----------------------------------
#
# Cloud KMS ist der Default-KEK-Provider im privat-Mode (siehe
# docs/privat.md §9 + docs/adr/0005-cloud-kms-decision.md). OpenBao bleibt
# als Alternative im Repo dokumentiert, ist aber NICHT mehr Default-Pfad.
#
# Auth: google-Provider liest GOOGLE_APPLICATION_CREDENTIALS (file) oder
# GOOGLE_APPLICATION_CREDENTIALS_JSON (inline) aus dem env. Der TF-Operator
# braucht für den ersten Apply einmalig einen User-OAuth-Login (`gcloud
# auth application-default login`); Service-Account-Key wird DANN von TF
# selbst generiert und in Doppler eingetragen.

variable "gcp_project_id" {
  type        = string
  default     = "axelrogg-ai-tools"
  description = "GCP-Project-ID. Single-Tenant: 1 Projekt pro Instance (privat-Mode hat sein eigenes, business-Mode pro Kunde eines)."
}

variable "gcp_project_number" {
  type        = string
  default     = ""
  description = "GCP-Project-Number (numeric, NICHT der Projekt-Slug). Wird für Workload-Identity-Federation-URIs gebraucht. Falls leer: TF resolved es zur Laufzeit via data.google_project."
}

variable "gcp_default_region" {
  type        = string
  default     = "europe-west3"
  description = "Default-GCP-Region für non-KMS-Resources (Cloud Run Skeleton, IAM-Policies-Storage etc.). KMS-Location ist separat — gcp_kms_location."
}

variable "gcp_kms_location" {
  type        = string
  default     = "eu"
  description = "Cloud-KMS-Location. `eu` = multi-region EU (default; gleiche Software-Tarife wie single-region, plus Region-Failover). Single-region-Alternative: `europe-west3` (Frankfurt), `europe-west6` (Zürich)."
}

variable "gcp_kms_key_ring_name" {
  type        = string
  default     = "mcp-approval2-privat"
  description = "Cloud-KMS-KeyRing-Name. Single Ring shared zwischen approval2 + knowledge2 — beide Services derivieren ihren Master via HKDF, sehen den unwrapped Master nie im Plaintext außerhalb Boot-Moment."
}

variable "gcp_kms_key_name" {
  type        = string
  default     = "user-dek-master"
  description = "Cloud-KMS-CryptoKey-Name. Auto-rotate 90 Tage (rotation_period=7776000s). Single Master-Key, unwrapped einmal beim Service-Boot, danach HKDF-deriviert per User."
}
