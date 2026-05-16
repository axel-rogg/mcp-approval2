# ============================================================================
# Google Vertex AI — Service-Account fuer KC2-Embedding-Calls (multilingual)
# ============================================================================
#
# Decision: separater Service-Account `mcp-knowledge2-vertex` (NICHT der
# bestehende `mcp-knowledge2-fly` aus gcp-kms.tf erweitern), aus zwei Gruenden:
#
# 1. **Blast-Radius-Isolation**: ein Vertex-Key-Leak greift nicht auf den
#    KMS-decrypter durch. Audit-Trail in Cloud Logging zeigt sauber pro
#    Concern welcher Principal welchen Call gemacht hat.
# 2. **Code-Kompatibilitaet**: KC2's `src/adapters/embed/vertex.ts` liest
#    `VERTEX_SERVICE_ACCOUNT_JSON` (Vertex-spezifischer env-var-Name) —
#    NICHT das allgemeine `GOOGLE_APPLICATION_CREDENTIALS_JSON` das fuer
#    KMS gilt. Mit getrenntem SA + getrennter Doppler-Variable bleiben
#    beide Adapter unabhaengig konfigurierbar.
#
# approval2 hat heute KEINEN aktiven Vertex-Use (`packages/adapters/src/ai/
# vertex.ts` ist da, wird aber nicht instanziiert; cost-tracker referenziert
# 'vertex' nur als Provider-Tag). Daher hier kein approval2-Vertex-SA — bei
# Bedarf trivial nachzuziehen (eine 4-Resource-Erweiterung).
#
# Spec-Reference:
#   - mcp-knowledge2/src/adapters/embed/vertex.ts (Auth-Mode `sa-json`)
#   - mcp-knowledge2/src/types/env.ts (VERTEX_PROJECT, VERTEX_LOCATION,
#                                       VERTEX_MODEL, VERTEX_SERVICE_ACCOUNT_JSON)
#   - docs/privat.md §2 (Vertex AI EU `text-multilingual-embedding-002`)
# ============================================================================

# ---------------------------------------------------------------------------
# Vertex AI API enablen
# ---------------------------------------------------------------------------

resource "google_project_service" "aiplatform" {
  project            = var.gcp_project_id
  service            = "aiplatform.googleapis.com"
  disable_on_destroy = false
}

# ---------------------------------------------------------------------------
# Service-Account fuer Vertex (nur KC2 heute)
# ---------------------------------------------------------------------------

resource "google_service_account" "knowledge2_vertex" {
  project      = var.gcp_project_id
  account_id   = "mcp-knowledge2-vertex"
  display_name = "mcp-knowledge2 (Fly.io) — Vertex AI User"
  description  = "Service-Account fuer KC2-Embedding-Calls (text-multilingual-embedding-002 in europe-west4). Darf NUR Vertex-Predict + Listen — keine Model-Training oder -Management-Rechte."

  depends_on = [google_project_service.iam]
}

# roles/aiplatform.user gibt:
#   - aiplatform.endpoints.predict          (Embedding + Generation Calls)
#   - aiplatform.models.get                 (Model-Existenz pruefen)
#   - aiplatform.locations.list/get         (Region-Discovery)
# NICHT: train, deploy, deleteModel, customMetadata write
resource "google_project_iam_member" "knowledge2_vertex_user" {
  project = var.gcp_project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.knowledge2_vertex.email}"
}

resource "google_service_account_key" "knowledge2_vertex" {
  service_account_id = google_service_account.knowledge2_vertex.name
  public_key_type    = "TYPE_X509_PEM_FILE"
  key_algorithm      = "KEY_ALG_RSA_2048"
}

# ---------------------------------------------------------------------------
# Doppler-Pipe — Vertex-Config + SA-JSON in KC2-Config
# ---------------------------------------------------------------------------

resource "doppler_secret" "knowledge2_vertex_service_account_json" {
  project = "mcp-knowledge2"
  config  = "fly"
  name    = "VERTEX_SERVICE_ACCOUNT_JSON"
  # base64decode weil google_service_account_key.private_key per Default
  # base64-encoded JSON liefert; KC2's vertex.ts erwartet raw JSON-String.
  value = base64decode(google_service_account_key.knowledge2_vertex.private_key)
}

resource "doppler_secret" "knowledge2_vertex_project" {
  project = "mcp-knowledge2"
  config  = "fly"
  name    = "VERTEX_PROJECT"
  value   = var.gcp_project_id
}

resource "doppler_secret" "knowledge2_vertex_location" {
  project = "mcp-knowledge2"
  config  = "fly"
  name    = "VERTEX_LOCATION"
  # europe-west4 (Niederlande) ist die naechstgelegene Region fuer
  # text-multilingual-embedding-002 — Frankfurt (europe-west3) hat das
  # Model nicht. Fly fra -> GCP eu-west4: ~8-12ms RTT. Embedding-Calls
  # haben pro-call ~50-200ms Inference-Latenz, also Round-Trip
  # unkritisch.
  value = "europe-west4"
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "knowledge2_vertex_service_account_email" {
  value       = google_service_account.knowledge2_vertex.email
  description = "Vertex-SA-Email fuer Audit-Queries (Cloud Logging Filter principalEmail=...)."
}

output "knowledge2_vertex_project" {
  value       = var.gcp_project_id
  description = "VERTEX_PROJECT-Wert. Bestaetigung dass der GCP-Project-ID fuer KMS+Vertex der gleiche ist (single-tenant pilot)."
}

output "knowledge2_vertex_location" {
  value       = "europe-west4"
  description = "Vertex-Region. europe-west4 statt eu-multi-region weil Vertex-APIs region-bound (eu-multi nur fuer KMS)."
}
