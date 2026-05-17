# ============================================================================
# Resend DNS-Records fuer ai-toolhub.org — Multi-User Tier 1
# ============================================================================
#
# Workflow (Vollautomatisch ab Bootstrap-Token, 1 manueller Schritt):
#
#   1. Resend.com signup, Bootstrap-API-Key ("Full access") erzeugen.
#   2. export RESEND_BOOTSTRAP_TOKEN=re_xxx
#      export DOPPLER_TOKEN=$(grep ^DOPPLER_TOKEN= .dev.vars | cut -d= -f2-)
#   3. bash scripts/resend-bootstrap.sh
#      → Script ruft Resend-API: POST /domains + POST /api-keys
#      → Schreibt DNS-Werte in resend.auto.tfvars (von TF automatisch geladen)
#      → Setzt RESEND_API_KEY + EMAIL_PROVIDER=resend in Doppler
#   4. bash scripts/doppler-run-terraform.sh apply -target=cloudflare_dns_record.resend_*
#      → Records sind in CF in < 1 min weltweit
#   5. Resend-Dashboard: "Verify Records" klicken → grün
#   6. fly secrets set (sync Doppler → Fly) + redeploy → Versand aktiv
#
# Resend liefert verschiedene Record-Types je nach Verify-Mode:
#   - DKIM: typisch CNAME `<token>._domainkey.<domain>` → `<token>.dkim.amazonses.com`
#           (kann auch TXT mit raw public-key sein wenn Resend so konfiguriert)
#   - SPF:  TXT auf `send.<domain>` (subdomain-pattern, Root-SPF bleibt intakt)
#   - MX:   MX auf `send.<domain>` → feedback-smtp.<region>.amazonses.com
# ============================================================================

variable "enable_resend_dns" {
  type        = bool
  default     = false
  description = "true wenn Resend-Bootstrap-Script die Werte gesetzt hat. Wird automatisch von resend.auto.tfvars ueberschrieben."
}

variable "resend_dkim_record_name" {
  type        = string
  default     = ""
  description = "DKIM-Record name (z.B. 'abc123._domainkey'). Vom Bootstrap-Script gesetzt."
}

variable "resend_dkim_record_value" {
  type        = string
  default     = ""
  description = "DKIM-Record value (CNAME-Target oder TXT-Inhalt). Vom Bootstrap-Script gesetzt."
}

variable "resend_dkim_record_type" {
  type        = string
  default     = "CNAME"
  description = "DKIM-Record type (CNAME oder TXT je nach Resend-Setup)."
}

variable "resend_spf_record_name" {
  type        = string
  default     = "send.ai-toolhub.org"
  description = "SPF-Record name."
}

variable "resend_spf_record_value" {
  type        = string
  default     = "v=spf1 include:amazonses.com ~all"
  description = "SPF-Record TXT-content."
}

variable "resend_mx_record_name" {
  type        = string
  default     = "send.ai-toolhub.org"
  description = "MX-Record name."
}

variable "resend_mx_record_value" {
  type        = string
  default     = "feedback-smtp.eu-west-1.amazonses.com"
  description = "MX-Record target (region-spezifisch)."
}

variable "resend_mx_record_priority" {
  type        = number
  default     = 10
  description = "MX-Record priority."
}

variable "resend_dmarc_policy" {
  type        = string
  default     = "v=DMARC1; p=none; rua=mailto:dmarc@ai-toolhub.org"
  description = "DMARC-Policy (optional aber empfohlen). p=none = monitoring-only."
}

# ----------------------------------------------------------------------------
# 1. DKIM
# ----------------------------------------------------------------------------

resource "cloudflare_dns_record" "resend_dkim" {
  count = var.enable_resend_dns ? 1 : 0

  zone_id = data.cloudflare_zone.ai_toolhub.id
  name    = var.resend_dkim_record_name
  type    = var.resend_dkim_record_type
  content = var.resend_dkim_record_value
  proxied = false
  ttl     = 3600
  comment = "managed-by:terraform — Resend DKIM (auto-bootstrap)"
}

# ----------------------------------------------------------------------------
# 2. SPF + MX auf send-Subdomain
# ----------------------------------------------------------------------------

resource "cloudflare_dns_record" "resend_send_mx" {
  count = var.enable_resend_dns ? 1 : 0

  zone_id  = data.cloudflare_zone.ai_toolhub.id
  name     = var.resend_mx_record_name
  type     = "MX"
  content  = var.resend_mx_record_value
  priority = var.resend_mx_record_priority
  proxied  = false
  ttl      = 3600
  comment  = "managed-by:terraform — Resend MX (auto-bootstrap)"
}

resource "cloudflare_dns_record" "resend_send_spf" {
  count = var.enable_resend_dns ? 1 : 0

  zone_id = data.cloudflare_zone.ai_toolhub.id
  name    = var.resend_spf_record_name
  type    = "TXT"
  content = var.resend_spf_record_value
  proxied = false
  ttl     = 3600
  comment = "managed-by:terraform — Resend SPF (auto-bootstrap)"
}

# ----------------------------------------------------------------------------
# 3. DMARC (Empfohlen, vom Bootstrap-Script NICHT ueberschrieben)
# ----------------------------------------------------------------------------

resource "cloudflare_dns_record" "resend_dmarc" {
  count = var.enable_resend_dns ? 1 : 0

  zone_id = data.cloudflare_zone.ai_toolhub.id
  name    = "_dmarc.ai-toolhub.org"
  type    = "TXT"
  content = var.resend_dmarc_policy
  proxied = false
  ttl     = 3600
  comment = "managed-by:terraform — Resend DMARC (monitoring policy)"
}

# ----------------------------------------------------------------------------
# Output
# ----------------------------------------------------------------------------

output "resend_dns_status" {
  description = "Verifikation nach apply: 'dig +short TXT <name>' fuer jeden Record. Resend-Dashboard → Verify Records."
  value = var.enable_resend_dns ? {
    enabled = true
    dkim    = "${var.resend_dkim_record_type} ${var.resend_dkim_record_name}"
    spf     = "TXT ${var.resend_spf_record_name}"
    mx      = "MX ${var.resend_mx_record_name} → ${var.resend_mx_record_value}"
    dmarc   = "TXT _dmarc.ai-toolhub.org"
  } : {
    enabled = false
    hint    = "bash scripts/resend-bootstrap.sh (siehe File-Header)"
  }
}
