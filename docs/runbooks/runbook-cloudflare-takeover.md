# Runbook: Cloudflare-Credentials Takeover aus mcp-approval

> Status: Ready
> Audience: Operator (Axel), Cloud-Agents (Claude Code)
> Trigger: Erste Terraform-Apply im frischen mcp-approval2-Repo

## Zweck

`mcp-approval2/terraform/` nutzt die **gleichen Cloudflare-Credentials** wie
`mcp-approval/terraform/`, aber managed komplett **separate Resources**.
Damit:

- keine neue API-Token-Generation noetig
- keine zweite R2-Bucket-Erstellung noetig
- aber **keinerlei** Risiko, dass der neue Repo bestehende mcp.*, app.*,
  knowledge.*-Records ueberschreibt

Die Isolation wird durch drei Mechanismen garantiert (Defense-in-Depth):

1. **Backend-Key-Isolation** — `mcp-approval2/privat/terraform.tfstate` vs.
   `mcp-approval/...` (separate State-Files im selben R2-Bucket).
2. **Read-only-Zone-Reference** — Zone-Object wird via `data "cloudflare_zone"`
   referenziert, niemals via `resource`. Keine Zone-Settings, Cert-Packs,
   Access-Apps oder Rulesets in diesem Repo.
3. **Reserved-Subdomain-Precondition** — `modules/cloudflare-dns` lehnt
   `terraform plan/apply` ab, wenn jemand `var.domain_mcp = "mcp.ai-toolhub.org"`
   (oder app/knowledge/gws/gcloud/utils) setzt.

## Wann nutzen

Beim erstem Setup von `mcp-approval2/terraform/environments/privat/` —
vor allem nach `git clone` und vor erstem `terraform init`.

## Schritte

### 1. Existing Values identifizieren

Im mcp-approval-Repo (auf einem nicht-Coop-Rechner):

```bash
cd /workspaces/mcp-approval

# Cloudflare-Token + R2-Creds
grep -E "CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY" .dev.vars

# Zone-ID aus Terraform-State
cd terraform
terraform state list | grep cloudflare_zone
terraform state show cloudflare_zone.ai_toolhub | grep -E '^[[:space:]]*id'

# Alternative: via API
curl -s 'https://api.cloudflare.com/client/v4/zones?name=ai-toolhub.org' \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq -r '.result[0].id'
```

Werte zu uebernehmen:

| Variable in mcp-approval2 | Source in mcp-approval |
|---|---|
| `cloudflare_api_token` | `.dev.vars` → `CLOUDFLARE_API_TOKEN` |
| `cloudflare_zone_id` | `terraform state` oder CF-API-Lookup |
| `r2_access_key_id` | `.dev.vars` → `R2_ACCESS_KEY_ID` |
| `r2_secret_access_key` | `.dev.vars` → `R2_SECRET_ACCESS_KEY` |

NICHT uebernehmen (mcp-approval2-spezifisch — neu generieren):

| Variable | Wie neu generieren |
|---|---|
| `hcloud_token` | Hetzner-Cloud-Console → Security → API tokens |
| `mcp_approval_internal_token` | `openssl rand -hex 32` |
| `operator_ssh_public_key` | `ssh-keygen -t ed25519 -C operator@laptop` |
| `hetzner_deploy_ssh_private_key` | `ssh-keygen -t ed25519 -f hetzner-deploy -N ''` |

### 2. tfvars eintragen

```bash
cd /workspaces/mcp-approval2/terraform/environments/privat
cp terraform.tfvars.example terraform.tfvars
nano terraform.tfvars
# Werte aus Schritt 1 eintragen + die mcp-approval2-spezifischen neu erzeugen
```

`terraform.tfvars` ist gitignored — niemals committen.

### 3. Verify Isolation (PFLICHT vor erstem apply)

```bash
cd /workspaces/mcp-approval2
bash scripts/verify-terraform-isolation.sh
```

Erwartete Ausgabe (Auszug):

```
✓ Backend-State-Key gehoert mcp-approval2
✓ Cloudflare-Zone wird read-only via data referenziert
✓ Reserved-Subdomain-Validation aktiv (modules/cloudflare-dns)
✓ mcp.ai-toolhub.org nicht im Plan (safe)
✓ app.ai-toolhub.org nicht im Plan (safe)
✓ knowledge.ai-toolhub.org nicht im Plan (safe)
...
✓ Isolation OK. Sicher fuer 'terraform apply'.
```

Bei `FAIL`: NICHT applyen. Output an User schicken.

### 4. Erstes Terraform-Apply

```bash
cd /workspaces/mcp-approval2/terraform/environments/privat

# Env fuer R2-Backend + Cloudflare-Provider
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID_VALUE"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY_VALUE"
export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_TOKEN_VALUE"
export GITHUB_TOKEN="ghp_..."     # PAT mit repo + workflow

terraform init
terraform plan -out=tfplan
# Plan-Output reviewen: alle Actions muessen "+ create" sein.
# Bei "~ update" oder "- destroy" auf existing mcp.*: STOPP, Plan
# wurde geleakt aus mcp-approval state. Niemals applyen.

terraform apply tfplan
```

### 5. Verify in der Cloudflare-UI

- `mcp2.ai-toolhub.org` zeigt auf neue Hetzner-IP (A-Record)
- `mcp.ai-toolhub.org` zeigt weiter auf den existing Worker (UNVERAENDERT!)
- DNS-Records-View muss beide Sets nebeneinander zeigen

## Safety-Garantien

| Was | Wie geschuetzt |
|---|---|
| Existing Records (mcp.*, app.*, knowledge.*, gws.*, gcloud.*, utils.*) | `data`-Block + Reserved-Subdomain-Precondition in `modules/cloudflare-dns` |
| Zone-Settings (SSL/TLS/HSTS, always_use_https) | NICHT in mcp-approval2/terraform/ — bleiben in mcp-approval/terraform/ |
| Cert-Packs | NICHT managed (Universal-Cert deckt alle Subdomains, inkl. mcp2.*, knowledge2.*, app2.*) |
| Access-Apps | NICHT managed |
| Rulesets (WAF, Rate-Limit) | NICHT managed |
| State-File-Konflikt | Backend-Key `mcp-approval2/privat/terraform.tfstate` (eigener Path) |
| Plan-Drift aus mcp-approval | Separate State-Files — `terraform refresh` im einen sieht den anderen NICHT |

## Was bleibt unter mcp-approval/terraform/'s Kontrolle

- `mcp.ai-toolhub.org` (Worker mcp-approval)
- `app.ai-toolhub.org` (Worker mcp-approval, PWA-Surface)
- `knowledge.ai-toolhub.org` (Worker mcp-knowledge)
- `gws.ai-toolhub.org` (Worker mcp-gws)
- `gcloud.ai-toolhub.org` (Worker mcp-gcloud)
- `utils.ai-toolhub.org` (Worker mcp-utils)
- Cloudflare-Zone-Object selbst + Zone-Settings (SSL, HSTS, always_use_https)
- D1-Databases, R2-Buckets, KV-Namespace
- Rulesets (WAF, Rate-Limit, Cache)
- Cert-Packs (Universal + advanced)
- Access-Applications (CF-Access fuer Admin-Surfaces)

## Was kommt unter mcp-approval2/terraform/'s Kontrolle (privat)

- `mcp2.ai-toolhub.org` (A/AAAA → Hetzner-VM)
- `knowledge2.ai-toolhub.org` (A/AAAA → Hetzner-VM)
- `app2.ai-toolhub.org` (A/AAAA → Hetzner-VM)
- Hetzner-Cloud-VM (`cx21` in `fsn1`)
- Hetzner-Firewall + optional Volume
- GitHub-Repo-Settings + Repo-Secrets (CLOUDFLARE_API_TOKEN, R2_*, HCLOUD_*, etc.)

## Troubleshooting

### "Plan zeigt destroy/update auf mcp.ai-toolhub.org"

= verify-terraform-isolation.sh haette das geblockt. Wenn doch passiert:

1. NICHT applyen
2. `terraform state list` checken: zeigt eine alte resource aus mcp-approval-import?
3. `terraform state rm <addr>` fuer alle fremden Adressen
4. verify-script nochmal laufen lassen

### "precondition failed: domain_mcp subdomain 'mcp' ist reserved"

= jemand hat in tfvars `domain_mcp = "mcp.ai-toolhub.org"` (ohne "2") gesetzt.
Fix: `domain_mcp = "mcp2.ai-toolhub.org"` (oder ein anderer freier Name).

### "Backend-Init fragt nach State-Migration"

= Backend-Key in `backend.tf` zeigt nicht mehr auf `mcp-approval2/privat/...`.
Fix: `backend.tf` pruefen, `terraform init -reconfigure`.

## Cross-references

- [scripts/verify-terraform-isolation.sh](../../scripts/verify-terraform-isolation.sh)
- [terraform/README.md](../../terraform/README.md) — Isolation-Sektion
- [terraform/modules/cloudflare-dns/main.tf](../../terraform/modules/cloudflare-dns/main.tf) — Precondition-Implementation
- mcp-approval-Repo: `terraform/README.md` (47 Resources, source-of-truth fuer Zone)
