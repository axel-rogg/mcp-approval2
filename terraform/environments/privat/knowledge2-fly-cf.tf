# ============================================================================
# Cloudflare Reverse-Proxy für mcp-knowledge2 (Fly-Custom-Domain)
# ============================================================================
#
# Bringt CF vor `mcp-knowledge2.fly.dev` für:
#   - Hide-Origin (Fly-FQDN bleibt versteckt)
#   - Basic DDoS-Mitigation (CF-Anycast)
#   - WAF-Bot-Fight-Mode (Free-Tier)
#   - Rate-Limiting für DCR-Spam-Mitigation
#   - SSL/TLS Full(strict) End-to-End
#
# Spec: docs/STRATEGIE-pilot.md §"Was AKTIV geschützt ist" +
#       docs/plans/active/PLAN-hardening.md im Schwester-Repo.
#
# ⚠️ **Conflict-Warning — vor Aktivierung lesen:**
#
# Das parallele `module.dns` (cloudflare-dns, in main.tf) legt aktuell einen
# A-Record `knowledge2.ai-toolhub.org` → Hetzner-VM-IPv4 an. Beim 2026-05-14-
# Pilot wurde die Hetzner-VM via `scripts/vm-destroy-only.sh` zerstört; der
# DNS-Record könnte noch als "stale" in der CF-Zone hängen oder bereits
# aufgeräumt sein.
#
# **Vor `terraform apply` mit count=1:**
#   1. CF-Dashboard prüfen: existiert der knowledge2-Record noch (A oder AAAA)?
#   2. Falls ja UND nicht TF-managed: manuell im Dashboard löschen ODER
#      `terraform destroy -target=module.dns.cloudflare_dns_record.knowledge`
#   3. Falls Hetzner-Setup ohnehin parked: `module "dns"` in main.tf um
#      `create_knowledge_record = false` erweitern (erfordert Modul-PR im
#      cloudflare-dns-Modul; siehe TODO unten)
#
# Default `count = 0` verhindert versehentliches Apply ohne diesen Check.
# ============================================================================

variable "enable_knowledge2_fly_cf" {
  type        = bool
  default     = true
  description = "Wenn true, legt CNAME knowledge2.ai-toolhub.org → mcp-knowledge2.fly.dev + WAF-Rules + Bot-Fight-Mode an. Default seit 2026-05-17 true (Hetzner-A-Record wurde 2026-05-14 destroyed, kein Konflikt mehr)."
}

variable "knowledge2_fly_fqdn" {
  type        = string
  default     = "mcp-knowledge2.fly.dev"
  description = "Fly-default-FQDN — wird vom CNAME target sein."
}

# ---------------------------------------------------------------------------
# CNAME knowledge2.ai-toolhub.org → mcp-knowledge2.fly.dev (proxied)
# ---------------------------------------------------------------------------

resource "cloudflare_dns_record" "knowledge2_fly_cname" {
  count = var.enable_knowledge2_fly_cf ? 1 : 0

  zone_id = data.cloudflare_zone.ai_toolhub.id
  name    = var.domain_knowledge
  type    = "CNAME"
  content = var.knowledge2_fly_fqdn
  proxied = true
  ttl     = 1 # auto when proxied=true
  comment = "managed-by:terraform — knowledge2-fly-cf (replaces hetzner-vm path)"
}

# ---------------------------------------------------------------------------
# _fly-ownership TXT-Record — Pflicht wenn CF-Proxy aktiv ist (orange cloud)
# ---------------------------------------------------------------------------
#
# Fly's TLS-Cert-Validation (ACME via Let's Encrypt) braucht entweder direkten
# DNS-Pfad (A/AAAA-Records auf Fly-IPs) ODER Ownership-Proof via TXT-Record
# wenn die Domain durch einen CDN/Proxy geroutet wird. Da wir CF-Proxy für
# DDoS-Protection + Cache wollen, gehen wir den TXT-Pfad.
#
# Token-Wert kommt aus `fly certs setup <domain>` und ist stable über
# fly_app-Reincarnations hinweg (an die App-ID gebunden, nicht an Cert-ID).
#
# Ohne diesen Record: knowledge2.ai-toolhub.org gibt HTTP 525 (SSL handshake
# failed) zurück weil CF keinen gültigen Origin-Cert findet.

resource "cloudflare_dns_record" "knowledge2_fly_ownership" {
  count = var.enable_knowledge2_fly_cf ? 1 : 0

  zone_id = data.cloudflare_zone.ai_toolhub.id
  name    = "_fly-ownership.${var.domain_knowledge}"
  type    = "TXT"
  content = "\"app-qj1x1nr\""
  proxied = false
  ttl     = 300
  comment = "managed-by:terraform — Fly TLS-Cert-Ownership-Proof (CF-Proxy-Pfad)"
}

# ---------------------------------------------------------------------------
# Zone-Settings — TLS + Bot Fight Mode (Free-Tier)
# ---------------------------------------------------------------------------
#
# Diese Settings gelten zonen-weit, also für alle Records inkl. mcp-approval/
# terraform/. Falls sie dort schon gesetzt sind, ist das ein no-op-apply.
# Setze count = 0 wenn der mcp-approval-TF diese Settings autoritativ managt.

resource "cloudflare_zone_setting" "knowledge2_ssl_full_strict" {
  count = var.enable_knowledge2_fly_cf ? 1 : 0

  zone_id    = data.cloudflare_zone.ai_toolhub.id
  setting_id = "ssl"
  value      = "strict" # Full-strict: CF erwartet gültiges Cert auf Origin (Fly hat LE auf *.fly.dev)
}

resource "cloudflare_zone_setting" "knowledge2_always_use_https" {
  count = var.enable_knowledge2_fly_cf ? 1 : 0

  zone_id    = data.cloudflare_zone.ai_toolhub.id
  setting_id = "always_use_https"
  value      = "on"
}

# ---------------------------------------------------------------------------
# fly_cert — Custom-Domain TLS-Cert auf Fly (analog approval2-fly-cf.tf)
# ---------------------------------------------------------------------------
#
# Provisioniert das TLS-Zertifikat fuer knowledge2.ai-toolhub.org auf der
# mcp-knowledge2 Fly-App. Validation laeuft via DNS-CNAME (siehe oben), keine
# manuelle ACME-Challenge noetig.
#
# Voraussetzung: mcp-knowledge2 Fly-App ist bereits angelegt (manuell via
# `fly apps create` ODER via eigenes fly_app-Resource in knowledge2-fly.tf,
# je nach lifecycle-decision).

resource "fly_cert" "knowledge2" {
  count = var.enable_knowledge2_fly_cf ? 1 : 0

  app      = "mcp-knowledge2"
  hostname = var.domain_knowledge

  depends_on = [cloudflare_dns_record.knowledge2_fly_cname]
}

# ---------------------------------------------------------------------------
# WAF — Rate-Limit auf /oauth/register (DCR-Spam-Mitigation)
# ---------------------------------------------------------------------------
#
# CF Free-Tier erlaubt 1 Rate-Limit-Rule per zone (Stand 2025/2026). Wir
# nutzen die für die offene DCR-Route, die ohne Auth ist. Limit: 10 req/min
# pro IP. Genug für legit MCP-Clients (registrieren ~1x/Tag), blockt aber
# Spam-Floods.
#
# Wenn du mehr als eine Rate-Limit-Rule auf der Zone hast, deaktiviere diese
# (count=0) oder upgrade auf CF Pro.

resource "cloudflare_ruleset" "knowledge2_rate_limit" {
  # Gate: braucht CF Pro Plan (Free erlaubt max 1 zone-ruleset pro
  # http_ratelimit-Phase, und der ist von der v1-Worker bereits belegt).
  # Default `false`: Defense-in-Depth durch In-Process-Rate-Limiter in
  # mcp-knowledge2/src/middleware/rate_limit.ts. Auf `true` setzen nach
  # CF-Pro-Upgrade oder wenn die v1-Worker-Ruleset migriert wurde.
  count = var.enable_knowledge2_fly_cf && var.enable_cf_zone_ratelimit ? 1 : 0

  zone_id     = data.cloudflare_zone.ai_toolhub.id
  name        = "knowledge2-rate-limit"
  description = "Rate-limit DCR + Auth-callback paths on knowledge2.ai-toolhub.org"
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [
    {
      action     = "block"
      expression = "(http.host eq \"${var.domain_knowledge}\" and starts_with(http.request.uri.path, \"/oauth/register\"))"
      description = "DCR-Spam: 10 req/min per IP, block on excess"
      ratelimit = {
        characteristics     = ["ip.src", "cf.colo.id"]
        period              = 60
        requests_per_period = 10
        mitigation_timeout  = 600
      }
    }
  ]
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "knowledge2_fly_cf_url" {
  value       = var.enable_knowledge2_fly_cf ? "https://${var.domain_knowledge}" : null
  description = "Public Custom-Domain für mcp-knowledge2 (wenn enable_knowledge2_fly_cf=true). Sonst direkt mcp-knowledge2.fly.dev nutzen."
}

# ---------------------------------------------------------------------------
# TODO — Folgeschritte für Aktivierung
# ---------------------------------------------------------------------------
# 1. `cloudflare-dns`-Modul um `create_knowledge_record = false`-Variable
#    erweitern (modules/cloudflare-dns/main.tf + variables.tf), damit der
#    knowledge2-A-Record aus dem Hetzner-Pfad sauber raus kann ohne `count`
#    auf module-Ebene zu setzen.
# 2. fly.toml `SELF_OAUTH_ISSUER` + `GOOGLE_OAUTH_REDIRECT_URI` auf
#    `https://${var.domain_knowledge}` umstellen (heute zeigen sie auf
#    https://mcp-knowledge2.fly.dev).
# 3. Google Cloud Console → OAuth Client → Authorized Redirect URI:
#    `https://${var.domain_knowledge}/auth/google/callback` ergänzen.
# 4. `fly certs add ${var.domain_knowledge} -a mcp-knowledge2` damit Fly
#    weiß dass die Custom-Domain gehört + DNS-Validation-Record als TXT
#    in CF anlegt (kann auch via TF gemacht werden, siehe optional unten).
