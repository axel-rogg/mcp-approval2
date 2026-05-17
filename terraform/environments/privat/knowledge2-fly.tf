# ============================================================================
# Fly.io — mcp-knowledge2 App-Stack (Pilot-Compute-Target)
# ============================================================================
#
# Manages the **stable** Fly resources for the mcp-knowledge2 Pilot:
#   - fly_app `mcp-knowledge2` (registers the App's existence)
#   - dedicated IPv6 (free, used for AAAA-records if a Custom-Domain is added)
#
# **NOT** in TF — bleibt bei flyctl + fly.toml + deploy/fly/deploy.sh:
#   - Image-Build + Deploy (`fly deploy` orchestriert Build + Push + Release)
#   - Postgres-Cluster (`fly postgres create` als separate Fly-App, der Provider
#     hat KEIN postgres-cluster-Resource)
#   - Postgres-Attach (setzt DATABASE_URL als Fly-Secret)
#   - Secret-Sync aus Doppler (deploy/fly/sync-secrets.sh via Doppler-CLI —
#     vermeidet, dass Secret-Werte im Terraform-State landen)
#   - knowledge_admin SQL-Step (manuell via psql)
#   - Dedicated IPv4 (kostet $2/mo; für Pilot reicht Fly's shared-v4)
#
# **Provider-Token-Pflege:**
#   Fly-Provider liest `FLY_API_TOKEN` aus der Umgebung. Mint via
#   `fly auth token` (das ist KEIN Org-deploy-token, sondern dein User-Token —
#   reicht für Pilot single-account). Pipe via `bash scripts/doppler-run-
#   terraform.sh` aus dem `mcp-approval2 / privat` Doppler-Config; oder export
#   manuell vor `terraform plan/apply`.
#
# **Idempotenz mit deploy/fly/deploy.sh:**
#   deploy.sh's Step 1 (`fly apps create mcp-knowledge2`) prüft bereits per
#   `fly apps list` ob die App existiert und skippt — siehe Repo
#   mcp-knowledge2 deploy/fly/deploy.sh. Reihenfolge ist also:
#     1. `terraform apply -target=fly_app.knowledge2` (legt App an)
#     2. `bash deploy/fly/deploy.sh` (sieht App existiert → skipt apps-create,
#         macht weiter mit postgres + secrets + deploy)
#
# Spec: docs/plans/active/PLAN-fly-terraform.md im Schwester-Repo.
# ============================================================================

provider "fly" {
  # Provider liest FLY_API_TOKEN aus der Umgebung (siehe Header oben).
  # Kein explizites Argument hier — alles geht via env-var, damit der Token
  # nicht in terraform.tfvars oder im State landet.
}

# ---------------------------------------------------------------------------
# fly_app — registriert die App-Existenz auf Fly
# ---------------------------------------------------------------------------

resource "fly_app" "knowledge2" {
  name = "mcp-knowledge2"
  org  = var.fly_org

  # Wenn die App schon via `fly apps create` angelegt wurde, TF importiert
  # sie statt zu replacen:
  #   terraform import fly_app.knowledge2 mcp-knowledge2
}

# ---------------------------------------------------------------------------
# fly_ip v6 — dedicated, free
# ---------------------------------------------------------------------------
#
# Reservation einer dedizierten IPv6 für die App. Dedicated IPv6 ist auf
# Fly free; dedicated IPv4 kostet $2/Monat und wird hier bewusst NICHT
# allokiert (Fly assigniert eine shared-v4 automatisch, reicht für Pilot
# ohne Custom-Domain). Wenn du später eine Custom-Domain mit DNS-A-Record
# willst, ergänze hier `resource "fly_ip" "knowledge2_v4" { type = "v4" }`.

resource "fly_ip" "knowledge2_v6" {
  app  = fly_app.knowledge2.name
  type = "v6"
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "knowledge2_fly_app_name" {
  value       = fly_app.knowledge2.name
  description = "Fly-App-Name (= `mcp-knowledge2`). Verifiziere mit `fly apps list`."
}

output "knowledge2_fly_app_id" {
  value       = fly_app.knowledge2.id
  description = "Fly-App-internal-ID (UUID). Für Cross-Resource-References."
}

output "knowledge2_fly_ipv6" {
  value       = fly_ip.knowledge2_v6.address
  description = "Dedizierte IPv6 der Fly-App. Für AAAA-DNS-Record bei Custom-Domain."
}

output "knowledge2_fly_url_default" {
  value       = "https://${fly_app.knowledge2.name}.fly.dev"
  description = "Default-URL der App (kein Custom-Domain). Verwendet bis DNS-Mapping eingerichtet ist."
}
