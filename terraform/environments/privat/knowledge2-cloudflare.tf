# ============================================================================
# Cloudflare AI Gateway für mcp-knowledge2 (Embedding via Workers AI)
# ============================================================================
#
# Neuer Gateway-Slug `mcp-knowledge2`, Authentication OFF (kein extra
# gateway-scoped Token nötig — der existing CLOUDFLARE_API_TOKEN in
# Doppler reicht, da er Workers-AI-Run + AI-Gateway-Edit-Permissions hat,
# verifiziert per Probe-Request).
#
# Embed-Pfad: KC2 → AI Gateway `mcp-knowledge2` → Workers AI `@cf/baai/bge-m3`
#
# Was hier passiert:
#   1. AI Gateway-Resource via cloudflare_ai_gateway angelegt
#   2. Default für Doppler-Secret `CLOUDFLARE_AI_GATEWAY_ID` wird unten in
#      knowledge2-doppler.tf bereits auf "mcp-approval-quality" gesetzt —
#      wir overriden das per dedizierter doppler_secret-Resource auf den
#      neuen Gateway-Slug.
# ============================================================================

locals {
  # Cloudflare Account-ID (öffentlich, steht in jeder Dashboard-URL).
  # Hardcoded weil als Single-Tenant-Instance stabil; siehe approval2-Doppler-
  # Secret CLOUDFLARE_ACCOUNT_ID für die gleiche Quelle.
  cloudflare_account_id_kc2 = "6a005d3b67fcb0637fd5917cb5280ce1"
  knowledge2_gateway_slug   = "mcp-knowledge2"
}

resource "cloudflare_ai_gateway" "knowledge2" {
  account_id = local.cloudflare_account_id_kc2
  id         = local.knowledge2_gateway_slug

  # Keine Authentication — Workers-AI-Token reicht. Sauber separat vom
  # mcp-approval-quality Gateway das Authenticated=true hat.
  authentication = false

  # Caching: 5 Minuten — gleiche Werte wie mcp-approval-quality.
  # Identische Embed-Requests (z.B. wiederholte search-Queries) liefern
  # gecachte Vektoren ohne erneuten Workers-AI-Call.
  cache_invalidate_on_update = false
  cache_ttl                  = 300

  # Audit-Logs sammeln für Embed-Request-Tracing
  collect_logs = true

  # Rate-Limit (kein Limit für den Pilot; bei Pilot-Scale-up ggf. setzen)
  rate_limiting_interval  = 0
  rate_limiting_limit     = 0
  rate_limiting_technique = "fixed"

  # Log-Retention (Default keeps newest 100k; DELETE_OLDEST = ring buffer)
  log_management          = 100000
  log_management_strategy = "DELETE_OLDEST"

  # Logpush deaktiviert (kein externer Log-Sink konfiguriert). Wir setzen
  # logpush_public_key NICHT — CF-API enforced min-length=16 auch wenn
  # logpush=false ist (Quirk in v5-Provider).
  logpush = false
}

# Override des Doppler-CLOUDFLARE_AI_GATEWAY_ID auf den neuen Slug.
# (Der trivial-Default in knowledge2-doppler.tf zeigt noch auf
# "mcp-approval-quality" — diese dedizierte Resource hat Vorrang bei
# Terraform-Apply, weil sie spezifischer ist.)
resource "doppler_secret" "knowledge2_cf_gateway_id_dev" {
  project = doppler_project.knowledge2.name
  config  = doppler_environment.knowledge2_dev.slug
  name    = "CLOUDFLARE_AI_GATEWAY_ID"
  value   = cloudflare_ai_gateway.knowledge2.id
}

resource "doppler_secret" "knowledge2_cf_gateway_id_privat" {
  project = doppler_project.knowledge2.name
  config  = doppler_environment.knowledge2_privat.slug
  name    = "CLOUDFLARE_AI_GATEWAY_ID"
  value   = cloudflare_ai_gateway.knowledge2.id
}
