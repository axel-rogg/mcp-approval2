# Terraform — mcp-approval2 multi-cloud deployment

Provisions infrastructure for mcp-approval2 + mcp-knowledge2 across two
workspaces:

- **`privat`** — single Hetzner Cloud VM in Frankfurt, Docker Compose stack,
  Cloudflare DNS pointing at it. ACTIVE.
- **`business`** — GCP Cloud Run + Cloud SQL. STUB only (Phase 2).

Both share the same Cloudflare zone (`ai-toolhub.org`) and the same R2-backed
Terraform state bucket, but each environment has an isolated state key so
plans never cross over.

## Layout

```
terraform/
├── README.md                           — this file
├── versions.tf                         — provider versions (root, informational)
├── backend.tf                          — root R2-backend defaults
├── .gitignore                          — *.tfstate, *.tfvars, .terraform/
│
├── modules/                            — reusable modules
│   ├── hetzner-mcp-instance/           — Hetzner VM + firewall + volume
│   ├── cloudflare-dns/                 — A + AAAA for 3 subdomains
│   └── gcp-mcp-instance/               — STUB (Phase 2)
│
└── environments/                       — terraform root modules (one per workspace)
    ├── privat/                         — ACTIVE
    └── business/                       — STUB (Phase 2)
```

## Workspace pattern

We use **directory-per-environment** (not `terraform workspace`). Rationale:

- Different cloud providers per environment (Hetzner vs. GCP) — each needs its
  own `.terraform/` plugin cache.
- Easier to reason about: `cd environments/privat && terraform plan` is
  unambiguous, no `workspace select` foot-gun.
- State keys stay readable: `mcp-approval2/<env>/terraform.tfstate`.

Each environment directory has its own `backend.tf` (state-key override),
`versions.tf` (provider req), `main.tf` (module wiring), `variables.tf`,
and `terraform.tfvars.example`.

## Bootstrap — `privat` workspace

```bash
# 1. Fill secrets
cd terraform/environments/privat
cp terraform.tfvars.example terraform.tfvars
nano terraform.tfvars      # hcloud_token, operator_ssh_public_key, cloudflare_zone_id

# 2. Load env (R2 backend + Cloudflare API token)
#    These live in your repo's .env or password manager.
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export CLOUDFLARE_API_TOKEN=...

# 3. Init + plan + apply
terraform init
terraform plan
terraform apply

# 4. Outputs
terraform output ssh_cmd
terraform output -json domains
```

## State backend

State lives in Cloudflare R2 (EU jurisdiction), same bucket as
`mcp-approval/terraform/`. Connection settings:

| Setting | Value |
|---|---|
| Bucket | `terraform-state` |
| Endpoint | `https://6a005d3b67fcb0637fd5917cb5280ce1.eu.r2.cloudflarestorage.com` |
| Region | `auto` |
| Path style | `true` |

State keys:

| Workspace | Key |
|---|---|
| privat | `mcp-approval2/privat/terraform.tfstate` |
| business | `mcp-approval2/business/terraform.tfstate` (Phase 2) |

Credentials are R2 API tokens (`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`)
from `.env` / `.dev.vars`. See `mcp-approval/terraform/README.md` for how
those were minted.

## Isolation von mcp-approval/terraform/

Dieses Repo (`mcp-approval2/terraform/`) ist **physisch getrennt** von
`mcp-approval/terraform/`, das die Zone `ai-toolhub.org` plus 47 weitere
Cloudflare-Resources (Worker-Domains, Cert-Packs, Access-Apps, Rulesets,
Zone-Settings) managed.

Wir teilen uns Credentials + R2-Bucket, niemals State-Files oder Resources:

| Layer | Trennung |
|---|---|
| Backend-State-Key | unterschiedliche Pfade im selben R2-Bucket (`mcp-approval2/privat/...` vs. `mcp-approval/...`) |
| Resources | nur neue Subdomain-Names (`mcp2.*`, `knowledge2.*`, `app2.*`) |
| Zone-Object | read-only via `data "cloudflare_zone"` in `environments/privat/main.tf` |
| Zone-Settings (SSL/TLS/HSTS) | NICHT managed im neuen Repo |
| Cert-Packs | NICHT managed (Universal-Cert deckt eh alle subs) |
| Access-Apps, Rulesets | NICHT managed |

Pre-Apply-Safety-Check (PFLICHT vor erstem apply):

```bash
bash scripts/verify-terraform-isolation.sh
```

Das Skript prueft:

- Backend-Key gehoert `mcp-approval2/privat`
- Keine `resource "cloudflare_zone"`-Blocks
- `modules/cloudflare-dns` hat Reserved-Subdomain-Precondition aktiv
- `terraform plan` zeigt KEIN destroy/update auf `mcp.*`, `app.*`,
  `knowledge.*`, `gws.*`, `gcloud.*`, `utils.*`

Garantien:

- `terraform apply` touched NIE Resources die in `mcp-approval/terraform/` leben
- `terraform destroy` zerstoert ausschliesslich eigene Resources
  (mcp2/knowledge2/app2 + Hetzner-VM)
- Beide Repos koennen parallel `terraform plan/apply` laufen lassen, ohne
  sich gegenseitig zu beeinflussen

Falls `var.domain_mcp = "mcp.ai-toolhub.org"` (ohne `2`) gesetzt wird:
`terraform plan` schlaegt mit einer aussagekraeftigen Precondition-Error fehl,
**bevor** irgend ein API-Call an Cloudflare rausgeht.

Setup-Anleitung fuer den Takeover der existing Credentials:
[docs/runbooks/runbook-cloudflare-takeover.md](../docs/runbooks/runbook-cloudflare-takeover.md).

## What's intentionally NOT here

- **Worker bindings (D1/R2/Vectorize/KV)** — those still live in
  `mcp-approval/terraform/` for the Cloudflare-Workers-based old stack.
  mcp-approval2 is a different runtime (Hetzner/Docker) — no Worker resources.
- **DNS for the workers.dev bypass domain** — managed by Cloudflare automatically,
  not Terraformable.
- **Hetzner Snapshots / Backups** — manual or scheduled via Hetzner UI / API
  for now. If a Terraformable resource becomes available we'll add it.
- **TLS cert provisioning** — handled by Caddy / Let's Encrypt inside the VM
  (cloud-init bootstrap), not by Cloudflare cert packs.

## Conventions inherited from `mcp-approval/terraform/`

- All resources tagged with `managed_by = "terraform"` label / comment.
- Cloudflare provider v5 (use `cloudflare_dns_record`, not legacy
  `cloudflare_record`).
- R2 backend uses S3-compatible API with EU-jurisdiction endpoint.
- Plan output should converge to `No changes` after each apply.

## Cost target (privat)

| Item | Monthly cost |
|---|---|
| Hetzner cx21 VM (4 vCPU / 8 GB) | ~6 EUR |
| Hetzner 20 GB volume (optional) | ~1 EUR |
| Cloudflare DNS / R2 storage | ~0 EUR (free tier) |
| **Total** | **< 10 EUR/Mo** |
