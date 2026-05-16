# ============================================================================
# Fly.io — mcp-approval2 App-Stack (Pilot-Compute-Target, Stand 2026-05-17)
# ============================================================================
#
# Manages the **stable** Fly resources for the mcp-approval2 Pilot:
#   - fly_app `mcp-approval2`              (registers the App's existence)
#   - dedicated IPv6                       (free, für AAAA-records bei Custom-Domain)
#
# Pattern identical zu knowledge2-fly.tf — symmetrisches Setup für beide Services.
#
# **NOT** in TF — bleibt bei flyctl + fly.toml + deploy/fly/deploy.sh:
#   - Image-Build + Deploy (`fly deploy` orchestriert Build + Push + Release)
#   - Postgres-Cluster (`fly postgres create` als separate Fly-App, der Provider
#     hat KEIN postgres-Resource — Status "todo" im fly-apps/fly Provider)
#   - Postgres-Attach (setzt DATABASE_URL als Fly-Secret)
#   - Secret-Sync aus Doppler (deploy/fly/deploy.sh → flyctl secrets set, vermeidet
#     dass Secret-Werte im Terraform-State landen)
#   - OpenBao operator init (Manual via `fly ssh console -a mcp-approval2-openbao`)
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
#   deploy.sh's Step 2 (`fly apps create mcp-approval2`) prüft bereits per
#   `fly apps list` ob die App existiert und skippt. Reihenfolge ist also:
#     1. `terraform apply -target=fly_app.approval2` (legt App an)
#     2. `bash deploy/fly/deploy.sh` (sieht App existiert → skipt apps-create,
#         macht weiter mit postgres + secrets + deploy)
#
# Spec-Reference: docs/privat.md §2 + §9.4
# ============================================================================

# ---------------------------------------------------------------------------
# fly_app — registriert die App-Existenz auf Fly
# ---------------------------------------------------------------------------

resource "fly_app" "approval2" {
  name = "mcp-approval2"
  org  = var.fly_org

  # Wenn die App schon via `fly apps create` angelegt wurde, TF importiert
  # sie statt zu replacen:
  #   terraform import fly_app.approval2 mcp-approval2
}

# ---------------------------------------------------------------------------
# fly_ip v6 — dedicated, free
# ---------------------------------------------------------------------------
#
# Reservation einer dedizierten IPv6 für die App. Dedicated IPv6 ist auf
# Fly free; dedicated IPv4 kostet $2/Monat und wird hier bewusst NICHT
# allokiert (Fly assigniert eine shared-v4 automatisch, reicht für Pilot
# ohne Custom-Domain). Wenn du später eine Custom-Domain mit DNS-A-Record
# willst (statt CNAME), ergänze:
#   resource "fly_ip" "approval2_v4" { type = "v4" app = fly_app.approval2.name }

resource "fly_ip" "approval2_v6" {
  app  = fly_app.approval2.name
  type = "v6"
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "approval2_fly_app_name" {
  value       = fly_app.approval2.name
  description = "Fly-App-Name (= `mcp-approval2`). Verifiziere mit `fly apps list`."
}

output "approval2_fly_app_id" {
  value       = fly_app.approval2.id
  description = "Fly-App-internal-ID (UUID). Für Cross-Resource-References."
}

output "approval2_fly_ipv6" {
  value       = fly_ip.approval2_v6.address
  description = "Dedizierte IPv6 der Fly-App. Für AAAA-DNS-Record bei Custom-Domain."
}

output "approval2_fly_url_default" {
  value       = "https://${fly_app.approval2.name}.fly.dev"
  description = "Default-URL der App (kein Custom-Domain). Verwendet bis DNS-Mapping eingerichtet ist."
}
