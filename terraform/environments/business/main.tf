# ============================================================================
# business/main.tf — GCP-deployed Business-Instance
# ============================================================================
#
# Provisioniert die GCP-Infrastruktur für mcp-knowledge2 (+ optional
# approval2 als Cloud-Run-Service):
#
#   - Cloud KMS Keyring + Key (für CMEK + für KMS_PROVIDER=cloud_kms
#     Master-Key-Wrapping in der KC2-App)
#   - Cloud SQL Postgres-Instance mit pgvector
#   - GCS Bucket für Blobs (BLOB_PROVIDER=gcs)
#   - Service-Account für Cloud Run-Runtime
#   - IAM-Bindings (Cloud Run → SQL Client, KMS Decrypter, GCS Object Admin,
#     Vertex AI User)
#
# **NICHT enthalten in dieser Datei** (TODO Phase 2.5 — User-spezifisch):
#   - Cloud Run Service-Resource selber (braucht Image-Push + erste Migration
#     vor Service-Create — entweder via gcloud-CLI oder separates TF-Modul)
#   - Workload Identity Federation für GitHub Actions (eigenes Modul)
#   - Cloud Load-Balancer + managed-SSL für custom-domain
#   - Monitoring/Alerting (Cloud Monitoring)
#
# Auth: setze GOOGLE_APPLICATION_CREDENTIALS oder gcloud auth application-
# default login bevor du `terraform apply` machst.

provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_region
}

provider "cloudflare" {
  # api_token via env CLOUDFLARE_API_TOKEN
}

# ----------------------------------------------------------------------------
# Pflicht-APIs aktivieren
# ----------------------------------------------------------------------------

resource "google_project_service" "required" {
  for_each = toset([
    "cloudkms.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "aiplatform.googleapis.com", # Vertex AI fallback
    "artifactregistry.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# ----------------------------------------------------------------------------
# Cloud KMS — Master-Key für KMS_PROVIDER=cloud_kms + CMEK für SQL
# ----------------------------------------------------------------------------

resource "google_kms_key_ring" "knowledge2" {
  name       = "knowledge2-business"
  location   = var.gcp_region
  depends_on = [google_project_service.required]
}

resource "google_kms_crypto_key" "master" {
  name            = "master"
  key_ring        = google_kms_key_ring.knowledge2.id
  rotation_period = "7776000s" # 90 days
  purpose         = "ENCRYPT_DECRYPT"
  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "SOFTWARE" # set to HSM for hardened deployments
  }
  lifecycle { prevent_destroy = true }
}

# Separate Key für Cloud-SQL CMEK (eigene Rotation + Audit-Scope)
resource "google_kms_crypto_key" "sql_cmek" {
  name            = "sql-cmek"
  key_ring        = google_kms_key_ring.knowledge2.id
  rotation_period = "7776000s"
  purpose         = "ENCRYPT_DECRYPT"
  lifecycle { prevent_destroy = true }
}

# ----------------------------------------------------------------------------
# Service-Account für Cloud Run Runtime
# ----------------------------------------------------------------------------

resource "google_service_account" "knowledge2_runtime" {
  account_id   = "knowledge2-runtime"
  display_name = "mcp-knowledge2 Cloud Run runtime"
}

# Cloud-KMS Decrypter (für master-key unwrap on boot)
resource "google_kms_crypto_key_iam_member" "runtime_kms_decrypt" {
  crypto_key_id = google_kms_crypto_key.master.id
  role          = "roles/cloudkms.cryptoKeyDecrypter"
  member        = "serviceAccount:${google_service_account.knowledge2_runtime.email}"
}

# Cloud-SQL Client (für DATABASE_URL via IAM-Auth)
resource "google_project_iam_member" "runtime_sql_client" {
  project = var.gcp_project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.knowledge2_runtime.email}"
}

# Vertex AI User (für EMBED_PROVIDER=vertex fallback)
resource "google_project_iam_member" "runtime_vertex_user" {
  project = var.gcp_project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.knowledge2_runtime.email}"
}

# ----------------------------------------------------------------------------
# Cloud Storage — Blob-Backend für BLOB_PROVIDER=gcs
# ----------------------------------------------------------------------------

resource "google_storage_bucket" "knowledge2_blob" {
  name                        = "${var.gcp_project_id}-knowledge2-blob"
  location                    = "EU" # multi-region für DSGVO-Posture
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning { enabled = true }

  lifecycle_rule {
    condition { age = 30 }
    action { type = "Delete" }
    # Note: KC2 has its own soft-delete via deleted_at + R2_KEY_REGEX. This
    # bucket lifecycle is a defense-in-depth for ophan blobs only.
  }

  depends_on = [google_project_service.required]
}

resource "google_storage_bucket_iam_member" "runtime_blob_admin" {
  bucket = google_storage_bucket.knowledge2_blob.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.knowledge2_runtime.email}"
}

# ----------------------------------------------------------------------------
# Cloud SQL — Postgres + pgvector
# ----------------------------------------------------------------------------

resource "random_password" "db_app" {
  length  = 32
  special = false
}

resource "random_password" "db_admin" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "knowledge2" {
  name             = "knowledge2-business"
  database_version = "POSTGRES_16"
  region           = var.gcp_region

  encryption_key_name = google_kms_crypto_key.sql_cmek.id

  settings {
    tier              = "db-custom-1-3840" # 1 vCPU, 3.75 GB RAM — start small
    availability_type = "ZONAL"            # upgrade to REGIONAL for HA later
    disk_type         = "PD_SSD"
    disk_size         = 20
    disk_autoresize   = true

    database_flags {
      name  = "cloudsql.enable_pgvector"
      value = "on"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 30
        retention_unit   = "COUNT"
      }
    }

    ip_configuration {
      ipv4_enabled    = false # private IP only
      private_network = null  # TODO: VPC + service-connection — set when known
      ssl_mode        = "ENCRYPTED_ONLY"
    }

    insights_config {
      query_insights_enabled = true
    }
  }

  deletion_protection = true

  depends_on = [
    google_project_service.required,
    google_kms_crypto_key_iam_member.sql_cmek_encrypter,
  ]
}

# Cloud SQL service-account muss CMEK-Decrypter sein
data "google_project" "current" {}

resource "google_kms_crypto_key_iam_member" "sql_cmek_encrypter" {
  crypto_key_id = google_kms_crypto_key.sql_cmek.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-cloud-sql.iam.gserviceaccount.com"
}

resource "google_sql_database" "knowledge" {
  name     = "knowledge"
  instance = google_sql_database_instance.knowledge2.name
}

resource "google_sql_user" "app" {
  name     = "knowledge_app"
  instance = google_sql_database_instance.knowledge2.name
  password = random_password.db_app.result
}

resource "google_sql_user" "admin" {
  name     = "knowledge_admin"
  instance = google_sql_database_instance.knowledge2.name
  password = random_password.db_admin.result
}

# ----------------------------------------------------------------------------
# Doppler-Project für business (Single-Source-of-Truth für KC2-Secrets)
# ----------------------------------------------------------------------------

provider "doppler" {
  # DOPPLER_TOKEN aus env
}

resource "doppler_project" "knowledge2_business" {
  name        = "mcp-knowledge2-business"
  description = "mcp-knowledge2 — GCP-Business-Instance (Cloud Run + Cloud SQL + GCS + Cloud KMS)"
}

resource "doppler_environment" "knowledge2_business_prd" {
  project = doppler_project.knowledge2_business.name
  slug    = "prd"
  name    = "Production"
}

# DB-Connection-Strings auto-piped vom SQL-Instance
resource "doppler_secret" "db_url" {
  project = doppler_project.knowledge2_business.name
  config  = doppler_environment.knowledge2_business_prd.slug
  name    = "DATABASE_URL"
  value = format(
    "postgres://%s:%s@%s/%s?host=/cloudsql/%s",
    google_sql_user.app.name,
    random_password.db_app.result,
    google_sql_database.knowledge.name,
    google_sql_database.knowledge.name,
    google_sql_database_instance.knowledge2.connection_name,
  )
}

resource "doppler_secret" "db_admin_url" {
  project = doppler_project.knowledge2_business.name
  config  = doppler_environment.knowledge2_business_prd.slug
  name    = "DATABASE_ADMIN_URL"
  value = format(
    "postgres://%s:%s@%s/%s?host=/cloudsql/%s",
    google_sql_user.admin.name,
    random_password.db_admin.result,
    google_sql_database.knowledge.name,
    google_sql_database.knowledge.name,
    google_sql_database_instance.knowledge2.connection_name,
  )
}

# Blob-Config (GCS-native)
resource "doppler_secret" "blob_provider" {
  project = doppler_project.knowledge2_business.name
  config  = doppler_environment.knowledge2_business_prd.slug
  name    = "BLOB_PROVIDER"
  value   = "gcs"
}

resource "doppler_secret" "blob_bucket" {
  project = doppler_project.knowledge2_business.name
  config  = doppler_environment.knowledge2_business_prd.slug
  name    = "BLOB_BUCKET"
  value   = google_storage_bucket.knowledge2_blob.name
}

resource "doppler_secret" "gcs_project" {
  project = doppler_project.knowledge2_business.name
  config  = doppler_environment.knowledge2_business_prd.slug
  name    = "GCS_PROJECT_ID"
  value   = var.gcp_project_id
}

# KMS-Config (Cloud KMS)
resource "doppler_secret" "kms_provider" {
  project = doppler_project.knowledge2_business.name
  config  = doppler_environment.knowledge2_business_prd.slug
  name    = "KMS_PROVIDER"
  value   = "cloud_kms"
}

resource "doppler_secret" "kms_key_name" {
  project = doppler_project.knowledge2_business.name
  config  = doppler_environment.knowledge2_business_prd.slug
  name    = "CLOUD_KMS_KEY_NAME"
  value   = google_kms_crypto_key.master.id
}

# CLOUD_KMS_WRAPPED_MASTER_B64 wird NICHT von TF generiert — User macht das
# einmalig nach dem ersten apply via:
#
#   echo -n "$(openssl rand 32)" | \
#     gcloud kms encrypt --key=<key-name> --plaintext-file=- --ciphertext-file=- | base64
#
# und trägt das Ergebnis im Doppler-Dashboard ein. Grund: TF würde den
# 32-byte-master-key plaintext im state speichern — das ist genau das was
# Cloud KMS verhindern soll.
resource "doppler_secret" "kms_wrapped_master_placeholder" {
  project = doppler_project.knowledge2_business.name
  config  = doppler_environment.knowledge2_business_prd.slug
  name    = "CLOUD_KMS_WRAPPED_MASTER_B64"
  value   = ""
  lifecycle { ignore_changes = [value] }
}

# Embedding (Vertex als GCP-natives Default; oder Cloudflare-Cross-Cloud)
resource "doppler_secret" "embed_provider" {
  project = doppler_project.knowledge2_business.name
  config  = doppler_environment.knowledge2_business_prd.slug
  name    = "EMBED_PROVIDER"
  value   = "vertex"
}

resource "doppler_secret" "vertex_project" {
  project = doppler_project.knowledge2_business.name
  config  = doppler_environment.knowledge2_business_prd.slug
  name    = "VERTEX_PROJECT"
  value   = var.gcp_project_id
}

resource "doppler_secret" "vertex_location" {
  project = doppler_project.knowledge2_business.name
  config  = doppler_environment.knowledge2_business_prd.slug
  name    = "VERTEX_LOCATION"
  value   = var.gcp_region
}

resource "doppler_secret" "vertex_model" {
  project = doppler_project.knowledge2_business.name
  config  = doppler_environment.knowledge2_business_prd.slug
  name    = "VERTEX_MODEL"
  value   = "text-multilingual-embedding-002"
}

# Service-Token für Cloud Run runtime (read-only)
resource "doppler_service_token" "knowledge2_business_run" {
  project = doppler_project.knowledge2_business.name
  config  = doppler_environment.knowledge2_business_prd.slug
  name    = "cloud-run-readonly"
  access  = "read"
}

# ----------------------------------------------------------------------------
# Outputs
# ----------------------------------------------------------------------------

output "kms_key_name" {
  value       = google_kms_crypto_key.master.id
  description = "Cloud KMS master-key resource name — use this with `gcloud kms encrypt` to produce CLOUD_KMS_WRAPPED_MASTER_B64."
}

output "sql_instance_connection_name" {
  value       = google_sql_database_instance.knowledge2.connection_name
  description = "Cloud SQL connection-name for Cloud Run (--add-cloudsql-instances flag)."
}

output "sql_instance_self_link" {
  value     = google_sql_database_instance.knowledge2.self_link
  sensitive = false
}

output "blob_bucket_name" {
  value       = google_storage_bucket.knowledge2_blob.name
  description = "GCS bucket name for KC2 blobs."
}

output "runtime_service_account_email" {
  value       = google_service_account.knowledge2_runtime.email
  description = "Bind this as the Cloud Run service runtime SA."
}

output "doppler_business_dashboard" {
  value       = "https://dashboard.doppler.com/workplace/projects/${doppler_project.knowledge2_business.name}/configs"
  description = "Doppler-UI für business-Config (Cloud-KMS-wrapped-master eintragen)."
}

output "doppler_business_run_token" {
  value       = doppler_service_token.knowledge2_business_run.key
  sensitive   = true
  description = "Doppler service-token für Cloud Run runtime — inject als DOPPLER_TOKEN env."
}

# ============================================================================
# NÄCHSTE SCHRITTE NACH `terraform apply` (manuell):
# ============================================================================
#
# 1. Cloud-KMS-wrapped Master-Key generieren:
#      MASTER=$(openssl rand 32 | base64)
#      echo -n "$MASTER" | base64 -d | \
#        gcloud kms encrypt --key=$(terraform output -raw kms_key_name) \
#        --plaintext-file=- --ciphertext-file=- | base64 -w0
#    → Result in Doppler eintragen als CLOUD_KMS_WRAPPED_MASTER_B64
#
# 2. Postgres-Migrations auf Cloud-SQL ausführen:
#      cloud-sql-proxy <conn-name> &
#      DATABASE_ADMIN_URL='postgres://knowledge_admin:...@127.0.0.1/knowledge' \
#        npm --prefix /workspaces/mcp-knowledge2 run db:migrate
#
# 3. Container-Image bauen + nach Artifact Registry pushen:
#      gcloud builds submit --tag $REGION-docker.pkg.dev/$PROJECT/kc2/server
#
# 4. Cloud Run Service deployen:
#      gcloud run deploy mcp-knowledge2 \
#        --image=$REGION-docker.pkg.dev/$PROJECT/kc2/server \
#        --service-account=$(terraform output -raw runtime_service_account_email) \
#        --add-cloudsql-instances=$(terraform output -raw sql_instance_connection_name) \
#        --set-env-vars=DOPPLER_TOKEN=$(terraform output -raw doppler_business_run_token)
# ============================================================================
