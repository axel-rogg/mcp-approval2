# ============================================================================
# Cloudflare R2 Buckets — Privat-Mode-Blob-Storage für approval2 + knowledge2
# ============================================================================
#
# Decision aus docs/privat.md §9.1 + §9.2 (2026-05-16):
#   - R2 EU-Jurisdiction für beide Services (Free Tier deckt 10 GB + unbegrenzter Egress)
#   - Pro Service zwei Buckets: blob (data) + backup
#   - Backup-Bucket mit 365d Retention via Lifecycle-Rule
#   - Object-Lock / Versioning soll bei R2 manuell aktiviert werden — der
#     CF-Provider v5 unterstützt das (noch) nicht als TF-Resource (siehe
#     CF-Docs API-Section). Out-of-Band-Schritt im Apply-Runbook.
#
# Spec-Reference: docs/privat.md §9
# Account-ID: aus Doppler (cloudflare_account_id Variable)

# ---------------------------------------------------------------------------
# approval2 Data-Bucket (für File-Uploads, Audit-Trail-Exports)
# ---------------------------------------------------------------------------

resource "cloudflare_r2_bucket" "approval2_blob_eu" {
  account_id   = var.cloudflare_account_id
  name         = "mcp-approval2-blob-eu"
  jurisdiction = "eu"
}

# ---------------------------------------------------------------------------
# approval2 Backup-Bucket (für encrypted pg_dump-Dateien)
# ---------------------------------------------------------------------------
#
# Operational-Hardening (privat.md §9.2):
#   - Eigener R2-API-Token für den Backup-Cron, nur PutObject + GetObject Scope,
#     KEIN Delete-Permission → out-of-band im CF-Dashboard anlegen
#   - Object-Lock / Bucket-Versioning für 30-90 Tage Compliance-Mode → manuell
#     aktivieren (CF-Provider unterstützt das aktuell nicht via TF)

resource "cloudflare_r2_bucket" "approval2_backup_eu" {
  account_id   = var.cloudflare_account_id
  name         = "mcp-approval2-backup-eu"
  jurisdiction = "eu"
}

resource "cloudflare_r2_bucket_lifecycle" "approval2_backup_eu" {
  account_id   = var.cloudflare_account_id
  bucket_name  = cloudflare_r2_bucket.approval2_backup_eu.name
  jurisdiction = "eu"

  rules = [
    {
      id      = "backup-retention-365d"
      enabled = true
      conditions = {
        prefix = "backup/"
      }
      delete_objects_transition = {
        condition = {
          max_age = 365 * 24 * 60 * 60 # 365 Tage
          type    = "Age"
        }
      }
    }
  ]
}

# ---------------------------------------------------------------------------
# knowledge2 Data-Bucket (für Object-Bodies > 16 KB, R2 statt Tigris)
# ---------------------------------------------------------------------------
#
# Migration-Note: knowledge2 startet mit Tigris (laut STRATEGIE-pilot.md §6).
# Switch auf R2 ist ein einfacher Doppler-Update (BLOB_*-Keys) + rsync der
# bestehenden Objects. Beim Erst-Setup direkt R2 wählen um die Migration zu
# überspringen.

resource "cloudflare_r2_bucket" "knowledge2_blob_eu" {
  account_id   = var.cloudflare_account_id
  name         = "mcp-knowledge2-blob-eu"
  jurisdiction = "eu"
}

# ---------------------------------------------------------------------------
# knowledge2 Backup-Bucket
# ---------------------------------------------------------------------------

resource "cloudflare_r2_bucket" "knowledge2_backup_eu" {
  account_id   = var.cloudflare_account_id
  name         = "mcp-knowledge2-backup-eu"
  jurisdiction = "eu"
}

resource "cloudflare_r2_bucket_lifecycle" "knowledge2_backup_eu" {
  account_id   = var.cloudflare_account_id
  bucket_name  = cloudflare_r2_bucket.knowledge2_backup_eu.name
  jurisdiction = "eu"

  rules = [
    {
      id      = "backup-retention-365d"
      enabled = true
      conditions = {
        prefix = "backup/"
      }
      delete_objects_transition = {
        condition = {
          max_age = 365 * 24 * 60 * 60
          type    = "Age"
        }
      }
    }
  ]
}

# ---------------------------------------------------------------------------
# Outputs — für Doppler-Pipe + Operator-Hinweise
# ---------------------------------------------------------------------------

output "approval2_r2_buckets" {
  description = "approval2 R2 bucket-Namen für Doppler-Secret BLOB_BUCKET + BACKUP_BUCKET."
  value = {
    blob_bucket   = cloudflare_r2_bucket.approval2_blob_eu.name
    backup_bucket = cloudflare_r2_bucket.approval2_backup_eu.name
    # EU-jurisdiction-Buckets MUESSEN das `.eu.`-Endpoint nutzen, sonst 403 (CF
    # gibt "bucket not found" als 403 zurueck wenn man am Global-Endpoint nach
    # einem EU-Bucket fragt). Drift-Bug 2026-05-16: ohne `.eu.` knallt knowledge2
    # /health/ready in HeadObject mit "UnknownError" (403 unter der Haube).
    endpoint      = "https://${var.cloudflare_account_id}.eu.r2.cloudflarestorage.com"
    region        = "auto"
  }
}

output "knowledge2_r2_buckets" {
  description = "knowledge2 R2 bucket-Namen für Doppler-Secret BLOB_BUCKET + BACKUP_BUCKET."
  value = {
    blob_bucket   = cloudflare_r2_bucket.knowledge2_blob_eu.name
    backup_bucket = cloudflare_r2_bucket.knowledge2_backup_eu.name
    # EU-jurisdiction-Buckets MUESSEN das `.eu.`-Endpoint nutzen, sonst 403 (CF
    # gibt "bucket not found" als 403 zurueck wenn man am Global-Endpoint nach
    # einem EU-Bucket fragt). Drift-Bug 2026-05-16: ohne `.eu.` knallt knowledge2
    # /health/ready in HeadObject mit "UnknownError" (403 unter der Haube).
    endpoint      = "https://${var.cloudflare_account_id}.eu.r2.cloudflarestorage.com"
    region        = "auto"
  }
}

output "r2_operator_next_steps" {
  description = "Out-of-band-Schritte nach `terraform apply`."
  value = <<-EOT
    Nach dem terraform apply:

    1. CF-Dashboard → R2 → Manage R2 API Tokens → vier Tokens erstellen:

       a) approval2-data-rw:
          Bucket: mcp-approval2-blob-eu  Permissions: Object Read & Write
       b) approval2-backup-cron:
          Bucket: mcp-approval2-backup-eu  Permissions: Object Read & Write
          (KEIN Delete — Defense-in-Depth gegen kompromittierten Cron)
       c) knowledge2-data-rw:
          Bucket: mcp-knowledge2-blob-eu  Permissions: Object Read & Write
       d) knowledge2-backup-cron:
          Bucket: mcp-knowledge2-backup-eu  Permissions: Object Read & Write
          (KEIN Delete)

    2. Doppler-Secrets pflegen (manuell oder via doppler-secrets-set):

       Doppler-Project: mcp-approval2 / privat
         BLOB_ENDPOINT      = https://<account>.eu.r2.cloudflarestorage.com
                              ↑ `.eu.` ist Pflicht — EU-Jurisdiction-Bucket
                                braucht das EU-Endpoint, sonst 403.
         BLOB_REGION        = auto
         BLOB_BUCKET        = mcp-approval2-blob-eu
         BLOB_ACCESS_KEY    = <approval2-data-rw AccessKey>
         BLOB_SECRET_KEY    = <approval2-data-rw SecretKey>
         BACKUP_BUCKET      = mcp-approval2-backup-eu
         BACKUP_ACCESS_KEY  = <approval2-backup-cron AccessKey>   (optional dediziert)
         BACKUP_SECRET_KEY  = <approval2-backup-cron SecretKey>

       Doppler-Project: mcp-knowledge2 / privat
         (analog mit knowledge2-Buckets + Token)

    3. R2 Bucket-Versioning + Object-Lock für die zwei Backup-Buckets aktivieren
       (CF-Dashboard → Bucket → Settings → Versioning + Lock; CF-Provider hat
       aktuell keine TF-Resource dafür — 2026-05-16 verifiziert).

    4. Smoke-Test: aws s3 ls --endpoint-url <endpoint> --profile r2-approval2
       (mit dem data-rw Token konfiguriert).
  EOT
}
