# ============================================================================
# Fly.io — mcp-approval2-openbao (separate App für OpenBao Transit-Engine)
# ============================================================================
#
# Side-Car-App für OpenBao (KEK-Provider). Lifecycle bewusst separat von
# mcp-approval2 — wir wollen Vault niemals als Nebeneffekt eines App-Deploys
# restarten (= Re-Seal-Pflicht). Internal-only (kein public listener), erreicht
# über Fly's `.internal` DNS (6PN) als `mcp-approval2-openbao.internal:8200`.
#
# Resources hier:
#   - fly_app `mcp-approval2-openbao`     (registriert App-Existenz)
#   - fly_volume `vault_data`             (1 GB, persistent Crypto-State)
#
# **NOT** in TF — bleibt manuell:
#   - Image-Build + Deploy (`fly deploy --config fly.openbao.toml`)
#   - `bao operator init`                 (initial-setup, einmalig, generiert
#                                           Unseal-Keys + Root-Token)
#   - `bao operator unseal`               (nach jedem Machine-Restart, 2-of-3)
#   - Transit-Engine + AppRole-Auth setup (`fly ssh console`-Steps)
#   - Volume-Snapshots                    (`fly volumes snapshots create`)
#
# **CRITICAL Operations-Reminder:**
#   - Unseal-Keys + Root-Token MÜSSEN offline gespeichert werden (Paper-Wallet /
#     verschlüsselter USB). Bei Volume-Verlust = Encrypted-Daten unwiederbringlich.
#   - vault_data Volume monatlich snapshotten (Doku in deploy/fly/README.md).
#
# Spec-Reference: docs/privat.md §9.3 + fly.openbao.toml
# ============================================================================

# ---------------------------------------------------------------------------
# fly_app — registriert die OpenBao-App-Existenz
# ---------------------------------------------------------------------------

resource "fly_app" "approval2_openbao" {
  count = var.enable_openbao_fly ? 1 : 0

  name = "mcp-approval2-openbao"
  org  = var.fly_org

  # Wenn die App schon via `fly apps create` angelegt wurde:
  #   terraform import 'fly_app.approval2_openbao[0]' mcp-approval2-openbao
}

# ---------------------------------------------------------------------------
# fly_volume — persistent Crypto-State für OpenBao file-backend
# ---------------------------------------------------------------------------
#
# 1 GB ist reichlich für KEKs + AppRole-Secrets. Bump nur wenn Transit für
# bulk-Daten-Wrap genutzt wird (nicht der approval2-Use-Case).
#
# Region MUSS gleich primary_region in fly.openbao.toml sein (`fra`), sonst
# kann die Machine nicht mounten.

resource "fly_volume" "approval2_openbao_data" {
  count = var.enable_openbao_fly ? 1 : 0

  app    = fly_app.approval2_openbao[0].name
  name   = "vault_data"
  size   = 1 # GB
  region = "fra"
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "approval2_openbao_fly_app_name" {
  value       = var.enable_openbao_fly ? fly_app.approval2_openbao[0].name : null
  description = "OpenBao-App-Name. Nur gesetzt wenn enable_openbao_fly=true. Sonst Cloud-KMS-Pfad aktiv (Default seit ADR-0011)."
}

output "approval2_openbao_internal_url" {
  value       = var.enable_openbao_fly ? "http://${fly_app.approval2_openbao[0].name}.internal:8200" : null
  description = "Internal-DNS-URL für VAULT_ADDR. Resolved nur innerhalb der Fly-6PN. Nur gesetzt wenn enable_openbao_fly=true."
}

output "approval2_openbao_volume_name" {
  value       = var.enable_openbao_fly ? fly_volume.approval2_openbao_data[0].name : null
  description = "Volume-Name für `fly volumes snapshots create -a mcp-approval2-openbao -v vault_data`. Nur gesetzt wenn enable_openbao_fly=true."
}
