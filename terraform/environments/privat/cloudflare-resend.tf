# ============================================================================
# Resend DNS-Records fuer ai-toolhub.org — Multi-User Tier 1
# ============================================================================
#
# Resend braucht 3-4 DNS-Records auf der sending-Domain damit der Email-
# Versand DKIM/SPF/DMARC-validiert wird:
#
#   1. DKIM (Pflicht): `resend._domainkey.ai-toolhub.org` TXT mit Public-Key
#      — Resend generiert den Wert bei `Add Domain` und zeigt ihn im Dashboard.
#   2. SPF (Pflicht): MX + SPF auf `send.ai-toolhub.org` (Resend nutzt eine
#      Subdomain damit der Root-SPF unbeeintraechtigt bleibt).
#   3. DMARC (Empfohlen): `_dmarc.ai-toolhub.org` TXT — Reporting + Policy.
#
# Operator-Setup-Sequenz:
#   1. resend.com signup, Free-Plan reicht (3000 mails/month).
#   2. Im Resend-Dashboard `Domains` → `Add Domain` → `ai-toolhub.org`.
#   3. Resend zeigt die 3 DNS-Records. Werte hier in die var.resend_*-
#      Variables uebertragen (oder direkt in den Resource-Block patchen).
#   4. `bash scripts/doppler-run-terraform.sh apply -target=...`
#   5. Im Resend-Dashboard "Verify Records" klicken — sollte direkt durch
#      sein (CF DNS-Propagation ist <1 min weltweit).
#   6. Resend API-Key generieren → `doppler secrets set RESEND_API_KEY=rs_...
#      --project mcp-approval2 --config fly` + `fly secrets set ...` + redeploy.
#   7. `EMAIL_PROVIDER` von "console" auf "resend" flippen (analog).
#
# Stand 2026-05-17: ALLE 4 var.resend_*-Variables sind Placeholder. enable_resend_dns
# ist false bis der User die echten Werte einpflegt — dann auf true setzen +
# apply.

variable "enable_resend_dns" {
  type        = bool
  default     = false
  description = "true wenn Resend signup + domain-add durch ist und die echten DKIM/SPF-Werte unten gesetzt sind. apply mit -target= um nur dieses File zu touchen."
}

variable "resend_dkim_public_key" {
  type        = string
  default     = "PLACEHOLDER_p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ..."
  description = "DKIM-Public-Key aus Resend-Dashboard. Format: 'p=<base64>;' oder 'v=DKIM1; k=rsa; p=<base64>;'. Resend zeigt den exakten String."
  sensitive   = false
}

variable "resend_spf_record" {
  type        = string
  default     = "v=spf1 include:amazonses.com ~all"
  description = "SPF-TXT-Wert. Resend nutzt aktuell AWS SES intern — der include-host kann sich aendern; Dashboard checkt."
}

variable "resend_mx_host" {
  type        = string
  default     = "feedback-smtp.us-east-1.amazonses.com"
  description = "MX-Target fuer send.ai-toolhub.org. Resend-Dashboard zeigt den region-spezifischen Host."
}

variable "resend_dmarc_policy" {
  type        = string
  default     = "v=DMARC1; p=none; rua=mailto:dmarc@ai-toolhub.org"
  description = "DMARC-Policy. p=none = monitoring only (keine reject/quarantine). Wird empfohlen aber nicht zwingend von Resend."
}

# ----------------------------------------------------------------------------
# 1. DKIM — Pflicht
# ----------------------------------------------------------------------------

resource "cloudflare_dns_record" "resend_dkim" {
  count = var.enable_resend_dns ? 1 : 0

  zone_id = data.cloudflare_zone.ai_toolhub.id
  name    = "resend._domainkey.ai-toolhub.org"
  type    = "TXT"
  content = var.resend_dkim_public_key
  proxied = false
  ttl     = 3600
  comment = "managed-by:terraform — Resend DKIM (Email-Tier-1)"
}

# ----------------------------------------------------------------------------
# 2. SPF auf send-Subdomain (Resend-Convention damit Root-SPF unangetastet bleibt)
# ----------------------------------------------------------------------------

resource "cloudflare_dns_record" "resend_send_mx" {
  count = var.enable_resend_dns ? 1 : 0

  zone_id  = data.cloudflare_zone.ai_toolhub.id
  name     = "send.ai-toolhub.org"
  type     = "MX"
  content  = var.resend_mx_host
  priority = 10
  proxied  = false
  ttl      = 3600
  comment  = "managed-by:terraform — Resend send-subdomain MX"
}

resource "cloudflare_dns_record" "resend_send_spf" {
  count = var.enable_resend_dns ? 1 : 0

  zone_id = data.cloudflare_zone.ai_toolhub.id
  name    = "send.ai-toolhub.org"
  type    = "TXT"
  content = var.resend_spf_record
  proxied = false
  ttl     = 3600
  comment = "managed-by:terraform — Resend SPF on send-subdomain"
}

# ----------------------------------------------------------------------------
# 3. DMARC (Empfohlen, nicht zwingend)
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
# Outputs — Operator-Verification
# ----------------------------------------------------------------------------

output "resend_dns_status" {
  description = "Checke alle Records: dig +short TXT resend._domainkey.ai-toolhub.org @1.1.1.1 ; dig +short TXT send.ai-toolhub.org ; dig +short MX send.ai-toolhub.org ; dig +short TXT _dmarc.ai-toolhub.org"
  value = var.enable_resend_dns ? {
    dkim_set  = "resend._domainkey.ai-toolhub.org"
    spf_send  = "send.ai-toolhub.org (TXT + MX)"
    dmarc_set = "_dmarc.ai-toolhub.org"
  } : {
    status = "DISABLED — set enable_resend_dns=true + fill var.resend_dkim_public_key after signup"
  }
}
