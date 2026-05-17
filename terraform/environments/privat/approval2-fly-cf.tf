# ============================================================================
# Cloudflare Reverse-Proxy + Fly Custom-Domain für mcp-approval2
# ============================================================================
#
# Bringt CF vor `mcp-approval2.fly.dev` für:
#   - Hide-Origin (Fly-FQDN bleibt versteckt)
#   - Basic DDoS-Mitigation (CF-Anycast)
#   - SSL/TLS Full(strict) End-to-End
#
# Pattern symmetrisch zu knowledge2-fly-cf.tf — beide Services nutzen das
# gleiche Layout, nur mit anderen FQDNs.
#
# ⚠️ **WebAuthn-Origin-Constraint:**
#   - CF-DNS-Records sind `proxied = false` damit der Browser direkt zur
#     Fly-Origin geht (WebAuthn ist Origin-bound — bei proxied=true würde der
#     CF-Edge die Origin verstecken und Passkey-Validation fehlschlagen).
#   - Verzichten wir auf CF-WAF/DDoS-Mitigation für approval2. Fly hat eigene
#     Anycast-Anti-DDoS-Layer.
#
# ⚠️ **Hetzner-Pfad-Cleanup-Status (2026-05-17):**
#   - Die alten A/AAAA-Records `mcp2/app2/knowledge2.ai-toolhub.org → Hetzner-VM-IP`
#     wurden am 2026-05-14 via `scripts/vm-destroy-only.sh` zerstört. Cloudflare-
#     Zone sollte sauber sein. Verifikation vor erstem Apply:
#         curl -sH "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
#           "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records?name.contains=2.ai-toolhub.org"
#     sollte leere `result[]`-Liste zurückgeben.
#
# Spec-Reference: docs/privat.md §6 (Domain + Whitelist)
# ============================================================================

variable "enable_approval2_fly_cf" {
  type        = bool
  default     = true
  description = "Wenn true, legt CNAMEs mcp2/app2.ai-toolhub.org → mcp-approval2.fly.dev + fly_cert an. Default true seit 2026-05-17 (Hetzner-Records wurden 2026-05-14 destroyed, keine Konflikte mehr)."
}

variable "approval2_fly_fqdn" {
  type        = string
  default     = "mcp-approval2.fly.dev"
  description = "Fly-default-FQDN — wird vom CNAME-Target sein."
}

# ---------------------------------------------------------------------------
# CNAME mcp2.ai-toolhub.org → mcp-approval2.fly.dev (proxied=false)
# ---------------------------------------------------------------------------

resource "cloudflare_dns_record" "approval2_mcp_cname" {
  count = var.enable_approval2_fly_cf ? 1 : 0

  zone_id = data.cloudflare_zone.ai_toolhub.id
  name    = var.domain_mcp
  type    = "CNAME"
  content = var.approval2_fly_fqdn
  proxied = false # WebAuthn-Origin-Constraint
  ttl     = 300
  comment = "managed-by:terraform — approval2-fly-cf MCP-API surface"
}

# ---------------------------------------------------------------------------
# CNAME app2.ai-toolhub.org → mcp-approval2.fly.dev (proxied=false)
# ---------------------------------------------------------------------------
#
# Same Fly-App serves PWA (statisches Bundle wird vom Hono-Server geliefert).
# Separater CNAME damit der app2-Origin-Header unterschiedlich zu mcp2 sein
# kann (Server differenziert via Host-Header in handlers).

resource "cloudflare_dns_record" "approval2_app_cname" {
  count = var.enable_approval2_fly_cf ? 1 : 0

  zone_id = data.cloudflare_zone.ai_toolhub.id
  name    = var.domain_app
  type    = "CNAME"
  content = var.approval2_fly_fqdn
  proxied = false # WebAuthn-Origin-Constraint
  ttl     = 300
  comment = "managed-by:terraform — approval2-fly-cf PWA surface"
}

# ---------------------------------------------------------------------------
# fly_cert — Custom-Domain TLS-Cert auf Fly
# ---------------------------------------------------------------------------
#
# `fly_cert` ist das TF-Equivalent zu `fly certs add <domain>`. Provisioniert
# das Let's-Encrypt-Cert für die Custom-Domain auf der Fly-App. Validation
# läuft über DNS-CNAME (siehe oben), keine manuelle ACME-Challenge nötig.
#
# Beide certs auf der gleichen App (approval2).

resource "fly_cert" "approval2_mcp" {
  count = var.enable_approval2_fly_cf ? 1 : 0

  app      = fly_app.approval2.name
  hostname = var.domain_mcp

  depends_on = [cloudflare_dns_record.approval2_mcp_cname]
}

resource "fly_cert" "approval2_app" {
  count = var.enable_approval2_fly_cf ? 1 : 0

  app      = fly_app.approval2.name
  hostname = var.domain_app

  depends_on = [cloudflare_dns_record.approval2_app_cname]
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "approval2_custom_domains" {
  description = "Aktive Custom-Domains (wenn enable_approval2_fly_cf=true)."
  value = var.enable_approval2_fly_cf ? {
    mcp_url       = "https://${var.domain_mcp}"
    app_url       = "https://${var.domain_app}"
    fly_origin    = "https://${var.approval2_fly_fqdn}"
    mcp_cert_id   = try(fly_cert.approval2_mcp[0].id, "n/a")
    app_cert_id   = try(fly_cert.approval2_app[0].id, "n/a")
  } : null
}
