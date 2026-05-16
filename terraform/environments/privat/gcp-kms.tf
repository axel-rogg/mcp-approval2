# ============================================================================
# Google Cloud KMS — KEK-Provider für approval2 + knowledge2 (privat-Mode)
# ============================================================================
#
# Default-KEK-Path seit 2026-05-17 — siehe ADR-0005 + docs/privat.md §9.
# Begründung: Operator-Realismus (kein USB/Paper-Wallet-Storage nötig),
# einfacheres Setup, FIPS-140-2-L1 (Software-Tier) + HSM-L3 als Upgrade-
# Pfad. OpenBao bleibt als alternative Selfhosting-Variante im Repo
# unter terraform/environments/privat-openbao/, ist aber NICHT mehr aktiv
# im Default-Plan.
#
# Was hier passiert:
#   - APIs aktivieren (cloudkms.googleapis.com, iamcredentials.googleapis.com)
#   - KeyRing in $gcp_kms_location (default `eu` multi-region)
#   - CryptoKey ENCRYPT_DECRYPT, software-protection, 90d auto-rotate
#   - Pro Service ein Service-Account (approval2-fly, knowledge2-fly)
#   - IAM-Binding: beide SAs als cryptoKeyEncrypterDecrypter
#   - Service-Account-Keys (JSON) werden generiert + an Doppler gepiped
#   - 32-byte Master-Plaintext (random_bytes) wird KMS-gewrappt
#     (google_kms_secret_ciphertext) + an Doppler gepiped
#
# Apply-Voraussetzungen (einmalig pro Maschine):
#   1. gcloud-CLI installiert
#   2. `gcloud auth application-default login` (User-OAuth, für TF-Apply)
#   3. Projekt billing-enabled (KMS API verlangt aktivierte Billing)
#   4. User hat im Projekt mindestens roles/owner ODER eine Composite
#      aus cloudkms.admin + iam.serviceAccountAdmin + iam.securityAdmin +
#      serviceusage.serviceUsageAdmin
#
# Apply-Reihenfolge:
#   1. APIs enablen + KeyRing/Key (~30s bis API verfügbar)
#   2. Service-Accounts + Keys
#   3. Wrapped-Master + IAM-Bindings + Doppler-Pipe
# Terraform sortiert das automatisch via Resource-Graph.
#
# Spec-Reference: docs/adr/0005-cloud-kms-decision.md + docs/privat.md §9
# Wire-Format-Erwartung: apps/server/src/index.ts (BootEnv.CLOUD_KMS_*)
#                       + mcp-knowledge2/src/adapters/kms/cloud_kms.ts
# ============================================================================

# ---------------------------------------------------------------------------
# Google-APIs enablen
# ---------------------------------------------------------------------------

resource "google_project_service" "cloudkms" {
  project            = var.gcp_project_id
  service            = "cloudkms.googleapis.com"
  disable_on_destroy = false # nicht beim destroy disablen — andere Services im Projekt könnten KMS noch nutzen
}

resource "google_project_service" "iamcredentials" {
  project            = var.gcp_project_id
  service            = "iamcredentials.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "iam" {
  project            = var.gcp_project_id
  service            = "iam.googleapis.com"
  disable_on_destroy = false
}

# ---------------------------------------------------------------------------
# KeyRing + CryptoKey
# ---------------------------------------------------------------------------

resource "google_kms_key_ring" "main" {
  project  = var.gcp_project_id
  name     = var.gcp_kms_key_ring_name
  location = var.gcp_kms_location

  depends_on = [google_project_service.cloudkms]
}

resource "google_kms_crypto_key" "user_dek_master" {
  name     = var.gcp_kms_key_name
  key_ring = google_kms_key_ring.main.id
  purpose  = "ENCRYPT_DECRYPT"

  # Rotation alle 90d. Wichtig: KMS-Key-Rotation rotiert NICHT den
  # wrapped Master-Key in Doppler — das braucht eine bewusste Re-Wrap-
  # Aktion (siehe docs/runbooks/runbook-kms-rotation.md).
  rotation_period = "7776000s" # 90 Tage

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "SOFTWARE" # HSM ist 16x teurer; für Pilot nicht nötig
  }

  # Schutz vor versehentlichem destroy. Wenn der Key weg ist, sind ALLE
  # damit gewrappten Daten unwiederbringlich.
  lifecycle {
    prevent_destroy = true
  }
}

# ---------------------------------------------------------------------------
# 32-byte Master-Plaintext (random) — wird KMS-gewrappt und nur als
# ciphertext in Doppler abgelegt. Plaintext landet im TF-State, R2-EU-
# Backend ist at-rest-encryptet → akzeptabler blast-radius.
# ---------------------------------------------------------------------------

resource "random_bytes" "user_dek_master_plaintext" {
  length = 32

  # Master rotiert NICHT automatisch (manuelle Re-Wrap-Aktion mit
  # Service-Restart). Falls jemals nötig: `terraform apply -replace=
  # random_bytes.user_dek_master_plaintext` → frischer master + alle
  # Daten müssen re-wrapped werden (Migration-Script).
  lifecycle {
    ignore_changes = [length]
  }
}

resource "google_kms_secret_ciphertext" "user_dek_master" {
  crypto_key = google_kms_crypto_key.user_dek_master.id
  plaintext  = random_bytes.user_dek_master_plaintext.base64

  # Wichtig: dieses Resource RE-KEYS automatisch wenn der CryptoKey eine
  # neue Primary-Version bekommt (auto-rotation alle 90d). Das wuerde
  # einen neuen ciphertext erzeugen und alle Services brauchen einen
  # Redeploy. Wir wollen das NICHT — alte ciphertexts bleiben gueltig
  # solange der KMS-Key noch alte Versions hat. Daher lifecycle.ignore_changes:
  lifecycle {
    ignore_changes = [crypto_key, plaintext]
  }
}

# ---------------------------------------------------------------------------
# Service-Accounts
# ---------------------------------------------------------------------------

resource "google_service_account" "approval2" {
  project      = var.gcp_project_id
  account_id   = "mcp-approval2-fly"
  display_name = "mcp-approval2 (Fly.io) — KMS-Reader"
  description  = "Service-Account für approval2-Fly-App. Darf NUR Cloud-KMS-Decrypt auf den user_dek_master Key. Kein anderer Scope."

  depends_on = [google_project_service.iam]
}

resource "google_service_account" "knowledge2" {
  project      = var.gcp_project_id
  account_id   = "mcp-knowledge2-fly"
  display_name = "mcp-knowledge2 (Fly.io) — KMS-Reader"
  description  = "Service-Account für knowledge2-Fly-App. Darf NUR Cloud-KMS-Decrypt auf den user_dek_master Key."

  depends_on = [google_project_service.iam]
}

# IAM: beide SAs als cryptoKeyEncrypterDecrypter
# (Decrypt für Master-Unwrap beim Boot; Encrypt würden wir nur bei
# Re-Wrap-Operations brauchen, das ist Operator-Task via gcloud CLI.)
resource "google_kms_crypto_key_iam_member" "approval2_decrypter" {
  crypto_key_id = google_kms_crypto_key.user_dek_master.id
  role          = "roles/cloudkms.cryptoKeyDecrypter"
  member        = "serviceAccount:${google_service_account.approval2.email}"
}

resource "google_kms_crypto_key_iam_member" "knowledge2_decrypter" {
  crypto_key_id = google_kms_crypto_key.user_dek_master.id
  role          = "roles/cloudkms.cryptoKeyDecrypter"
  member        = "serviceAccount:${google_service_account.knowledge2.email}"
}

# ---------------------------------------------------------------------------
# Service-Account-Keys (JSON-Credentials für Fly-Apps via ADC)
# ---------------------------------------------------------------------------
#
# Wir generieren long-lived JSON-Keys und legen sie in Doppler ab. Future-
# Hardening: Workload-Identity-Federation mit Fly OIDC, dann sind keine
# Keys mehr nötig — aktuell ist die Fly OIDC-Token-Refresh-Komplexität
# zu hoch für den Pilot-Scope.
#
# Key-Rotation: alle 6-12 Monate via `terraform apply -replace=
# google_service_account_key.approval2`. Doppler aktualisiert sich, naechster
# Fly-Deploy zieht den neuen Key. Alter Key bleibt 24h aktiv für Übergang.

resource "google_service_account_key" "approval2" {
  service_account_id = google_service_account.approval2.name
  public_key_type    = "TYPE_X509_PEM_FILE"
  key_algorithm      = "KEY_ALG_RSA_2048"
}

resource "google_service_account_key" "knowledge2" {
  service_account_id = google_service_account.knowledge2.name
  public_key_type    = "TYPE_X509_PEM_FILE"
  key_algorithm      = "KEY_ALG_RSA_2048"
}

# ---------------------------------------------------------------------------
# Doppler-Pipe — KMS-Konfiguration in beide Service-Configs
# ---------------------------------------------------------------------------

locals {
  cloud_kms_key_name = google_kms_crypto_key.user_dek_master.id
  # Format ist projects/<PROJECT>/locations/<LOC>/keyRings/<RING>/cryptoKeys/<KEY>
  # → matched die Erwartung von KeyManagementServiceClient.decrypt({name: ...})
}

# --- approval2 ---
resource "doppler_secret" "approval2_kms_provider" {
  project = "mcp-approval2"
  config  = "fly"
  name    = "KMS_PROVIDER"
  value   = "cloud_kms"
}

resource "doppler_secret" "approval2_cloud_kms_key_name" {
  project = "mcp-approval2"
  config  = "fly"
  name    = "CLOUD_KMS_KEY_NAME"
  value   = local.cloud_kms_key_name
}

resource "doppler_secret" "approval2_cloud_kms_wrapped_master" {
  project = "mcp-approval2"
  config  = "fly"
  name    = "CLOUD_KMS_WRAPPED_MASTER_B64"
  value   = google_kms_secret_ciphertext.user_dek_master.ciphertext
}

resource "doppler_secret" "approval2_google_application_credentials_json" {
  project = "mcp-approval2"
  config  = "fly"
  name    = "GOOGLE_APPLICATION_CREDENTIALS_JSON"
  # google_service_account_key.private_key ist base64-encoded JSON laut
  # Provider-Doku. Der CloudKmsKekProvider akzeptiert beides (raw JSON
  # via Inline-Pattern, base64-JSON via TF-Default-Pattern) — wir geben
  # hier base64-decoded raw JSON rein damit andere Google-Clients (die
  # nur raw JSON erwarten) den gleichen Secret weiterverwenden koennen.
  value = base64decode(google_service_account_key.approval2.private_key)
}

# --- knowledge2 ---
resource "doppler_secret" "knowledge2_kms_provider" {
  project = "mcp-knowledge2"
  config  = "fly"
  name    = "KMS_PROVIDER"
  value   = "cloud_kms"
}

resource "doppler_secret" "knowledge2_cloud_kms_key_name" {
  project = "mcp-knowledge2"
  config  = "fly"
  name    = "CLOUD_KMS_KEY_NAME"
  value   = local.cloud_kms_key_name
}

resource "doppler_secret" "knowledge2_cloud_kms_wrapped_master" {
  project = "mcp-knowledge2"
  config  = "fly"
  name    = "CLOUD_KMS_WRAPPED_MASTER_B64"
  value   = google_kms_secret_ciphertext.user_dek_master.ciphertext
}

resource "doppler_secret" "knowledge2_google_application_credentials_json" {
  project = "mcp-knowledge2"
  config  = "fly"
  name    = "GOOGLE_APPLICATION_CREDENTIALS_JSON"
  value   = base64decode(google_service_account_key.knowledge2.private_key)
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "gcp_kms_key_name" {
  value       = local.cloud_kms_key_name
  description = "Voll-qualifizierter KMS-Key-Resource-Name. Wird automatisch in beide Doppler-Configs als CLOUD_KMS_KEY_NAME geschrieben — der Output ist nur fuer Diagnostics."
}

output "gcp_kms_key_ring" {
  value       = google_kms_key_ring.main.id
  description = "KeyRing-Resource-Name (Diagnostics)."
}

output "gcp_kms_location" {
  value       = var.gcp_kms_location
  description = "KMS-Location (default `eu` multi-region)."
}

output "approval2_service_account_email" {
  value       = google_service_account.approval2.email
  description = "SA-Email fuer approval2. Bei Audit-Trail-Queries (Cloud Logging) als principal sichtbar."
}

output "knowledge2_service_account_email" {
  value       = google_service_account.knowledge2.email
  description = "SA-Email fuer knowledge2."
}
