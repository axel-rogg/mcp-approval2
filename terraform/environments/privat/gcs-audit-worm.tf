# GCS WORM Audit Sink — P2-8.
#
# Compliance-Use-Case: SOC-2 / ISO-27001 fordern manipulationsfreie
# Audit-Trails. Pg-Sink ist source-of-truth fuer Live-Queries; dieser
# GCS-Bucket ist defense-in-depth fuer Tamper-Evidence ueber lange
# Retention-Zeitraeume (90d Default; per `var.gcs_audit_retention_days`
# anpassbar fuer regulierte Branchen).
#
# Family-Mode: dormant. Operator setzt `var.gcs_audit_enabled = true`
# nur wenn Compliance-Bedarf besteht. Default ist false damit der GCS-
# Bucket nicht ungewollt anfaellt.
#
# Code-Pfad: apps/server/src/services/audit-sink.ts GcsWormSink
# Aktivierung: Doppler-Secret AUDIT_SINK_MODE=pg+gcs (+ Service-Account
# JSON via GCS_AUDIT_SA_JSON). Operator setzt das nach apply.

variable "gcs_audit_enabled" {
  type        = bool
  default     = false
  description = "Wenn true: legt GCS-Bucket + Service-Account fuer WORM-Audit an. Default false (Family-Mode braucht das nicht)."
}

variable "gcs_audit_retention_days" {
  type        = number
  default     = 90
  description = "Retention-Period in Tagen. 90 ist SOC-2-Mindestmass; ISO-27001 oft 365+. GDPR-Konflikt beachten — Erase-Requests koennen Audit-Trail nicht 'innerhalb der Retention' geloescht werden (legal hold pattern)."
}

variable "gcs_audit_location" {
  type        = string
  default     = "EUROPE-WEST3"
  description = "Single-region statt multi-region EU — analog zu KMS (ADR-0011) wegen Provider-Bug mit eu-multi-region. Audit-Daten sind EU-only."
}

# ---------------------------------------------------------------------------
# Bucket mit Object-Retention-Policy (Bucket-Level WORM)
# ---------------------------------------------------------------------------

resource "google_storage_bucket" "audit_worm" {
  count = var.gcs_audit_enabled ? 1 : 0

  project       = var.gcp_project_id
  name          = "${var.gcp_project_id}-mcp-approval2-audit-worm"
  location      = var.gcs_audit_location
  force_destroy = false # NIE auto-destroy — wuerde Retention-Policy umgehen

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Versioning ist Pflicht damit Retention-Policy greift. Ohne Versioning
  # kann man via overwrite die immutability umgehen.
  versioning {
    enabled = true
  }

  # Retention-Policy: Objekte sind fuer N Tage immutable (DELETE + OVERWRITE
  # blockiert). Nach Retention-Ablauf koennen sie geloescht werden — aber
  # bis dahin garantiert manipulationsfrei.
  retention_policy {
    retention_period = var.gcs_audit_retention_days * 86400
    is_locked        = false # locked=true ist permanent + irreversibel. Erst manuell aktivieren wenn Compliance-Audit ansteht.
  }

  # Lifecycle-Rule: nach 2x Retention objekte permanently delete (Storage-Cost-
  # Kontrolle). Vorher: keine Aktion, retention_policy enforced.
  lifecycle_rule {
    condition {
      age = var.gcs_audit_retention_days * 2
    }
    action {
      type = "Delete"
    }
  }

  # GDPR-Erase-Hinweis: Erase eines Users entfernt KEINE Audit-Eintraege im
  # Retention-Window. Legal hold pattern. Audit-Eintraege sind durch
  # pseudonymisierte user_ids (siehe knowledge.user.erased-Audit-Action)
  # ohnehin nicht direkt PII-loaded.

  labels = {
    purpose = "audit-worm"
    app     = "mcp-approval2"
    managed = "terraform"
  }
}

# ---------------------------------------------------------------------------
# Service-Account fuer den GcsWormSink (write-only zum Bucket)
# ---------------------------------------------------------------------------

resource "google_service_account" "audit_writer" {
  count = var.gcs_audit_enabled ? 1 : 0

  project      = var.gcp_project_id
  account_id   = "mcp-approval2-audit-writer"
  display_name = "mcp-approval2 (Fly.io) — Audit-WORM-Writer"
  description  = "Service-Account fuer GcsWormSink. Darf NUR Audit-Bucket Objects.create — keine list/get/delete (defense-in-depth: kompromittierter Service kann max append, nicht audit-trail manipulieren)."

  depends_on = [google_project_service.iam]
}

# Nur objectCreator — kein objectAdmin. Once-written-never-modified.
resource "google_storage_bucket_iam_member" "audit_writer_create" {
  count = var.gcs_audit_enabled ? 1 : 0

  bucket = google_storage_bucket.audit_worm[0].name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.audit_writer[0].email}"
}

# Compliance-Officer-Lesepfad: separate IAM (kommt in Phase-3 wenn jemand
# wirklich auditiert wird). Heute nicht vergeben — Compliance-Audit muss
# ueber google_project_iam_member separater Ressource freigeschaltet werden.

# ---------------------------------------------------------------------------
# Doppler-Push: SA-JSON fuer Fly-Pickup
# ---------------------------------------------------------------------------

resource "google_service_account_key" "audit_writer_key" {
  count = var.gcs_audit_enabled ? 1 : 0

  service_account_id = google_service_account.audit_writer[0].id
}

resource "doppler_secret" "gcs_audit_sa_json" {
  count = var.gcs_audit_enabled ? 1 : 0

  project = "mcp-approval2"
  config  = "fly"
  name    = "GCS_AUDIT_SA_JSON"
  value   = base64decode(google_service_account_key.audit_writer_key[0].private_key)
}

resource "doppler_secret" "gcs_audit_bucket" {
  count = var.gcs_audit_enabled ? 1 : 0

  project = "mcp-approval2"
  config  = "fly"
  name    = "GCS_AUDIT_BUCKET"
  value   = google_storage_bucket.audit_worm[0].name
}

# Operator-Hinweis: nach `terraform apply` zusaetzlich Doppler setzen:
#   doppler secrets set AUDIT_SINK_MODE pg+gcs --project mcp-approval2 --config fly
#   bash deploy/fly/sync-secrets.sh
#   fly deploy --remote-only -a mcp-approval2
#
# Verifizieren:
#   gcloud storage ls gs://${google_storage_bucket.audit_worm[0].name}/audit/
#   # nach ein paar Audit-Events sollten dort yyyy/mm/dd/-Pfade auftauchen

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "gcs_audit_bucket" {
  value       = var.gcs_audit_enabled ? google_storage_bucket.audit_worm[0].name : null
  description = "GCS-Bucket fuer WORM-Audit-Trail (null wenn disabled)"
}

output "gcs_audit_writer_sa" {
  value       = var.gcs_audit_enabled ? google_service_account.audit_writer[0].email : null
  description = "Service-Account fuer Audit-Sink-Writes"
}
