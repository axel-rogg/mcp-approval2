# Environment: privat
# ============================================================================
# Manages Cloudflare-Zone-References + Doppler + GitHub für die Fly.io-basierte
# privat-Mode-Instance von mcp-approval2.
#
# Architektur-Wahrheit: docs/privat.md (Stand 2026-05-17, Fly.io-Switch).
#
# Was hier NICHT mehr läuft (Hetzner-Pfad deprecated 2026-05-17):
#   - Hetzner-VM-Module wurde entfernt — Compute jetzt auf Fly.io via flyctl
#   - DNS-A-Records für mcp2/knowledge2/app2.ai-toolhub.org wurden destroyed
#     am 2026-05-14, werden durch CNAME-Records (in CF-Dashboard via
#     `fly certs add`-Workflow) ersetzt — NICHT mehr terraform-managed
#
# Was hier weiter läuft:
#   - Doppler-Project + Configs (privat / business)
#   - GitHub-Repo + Branch-Protection + GH-Action-Secrets
#   - Cloudflare-Zone-Data-Reference (read-only, Anker für AI-Gateway etc.)
#   - knowledge2-Doppler-Config + Fly-CF-Setup-Module (im selben State)
#
# Bootstrap:
#   bash scripts/doppler-run-terraform.sh init
#   bash scripts/doppler-run-terraform.sh plan
#   bash scripts/doppler-run-terraform.sh apply
# ============================================================================

provider "cloudflare" {
  # Reads CLOUDFLARE_API_TOKEN from env automatically.
}

# ---------------------------------------------------------------------------
# Read-only reference to the existing Cloudflare zone.
#
# WICHTIG: Wir managen die Zone NICHT in diesem Repo. Die Zone
# ai-toolhub.org wird in /workspaces/mcp-approval/terraform/ managed
# (Zone-Object, Zone-Settings, SSL/TLS, HSTS, Cert-Packs, Access-Apps,
# Rulesets etc.). Hier wird sie ausschliesslich read-only referenziert.
#
# DNS-Records für Fly-Custom-Domains werden über das CF-Dashboard
# oder das knowledge2-fly-cf.tf-Modul angelegt (CNAME zu *.fly.dev,
# proxied=false wegen WebAuthn-Origin-Constraint).
# ---------------------------------------------------------------------------

data "cloudflare_zone" "ai_toolhub" {
  filter = {
    name = "ai-toolhub.org"
  }
}

# ---------------------------------------------------------------------------
# Outputs — Cloudflare-Zone-ID + Doppler-Project-Outputs für Operator-Use.
# Fly-spezifische Outputs (URLs, IPs) gibt es nicht — `flyctl status` /
# `fly secrets list` sind die operativen Befehle.
# ---------------------------------------------------------------------------

output "cloudflare_zone_id" {
  value       = data.cloudflare_zone.ai_toolhub.zone_id
  description = "Cloudflare-Zone-ID für ai-toolhub.org (read-only)."
}

output "fly_apps" {
  description = "Fly-Apps die für privat-Mode deployed werden müssen (via bash deploy/fly/deploy.sh)."
  value = {
    approval2_app     = "mcp-approval2"
    knowledge2_app    = "mcp-knowledge2"
    approval2_openbao = var.enable_openbao_fly ? "mcp-approval2-openbao" : "(disabled — Cloud-KMS Default seit ADR-0011)"
  }
}

output "custom_domains" {
  description = "Custom-Domains (TF-managed via cloudflare_dns_record + fly_cert)."
  value = {
    mcp       = "mcp.ai-toolhub.org       → mcp-approval2.fly.dev"
    app       = "app.ai-toolhub.org       → mcp-approval2.fly.dev"
    knowledge = "knowledge.ai-toolhub.org → mcp-knowledge2.fly.dev"
  }
}
