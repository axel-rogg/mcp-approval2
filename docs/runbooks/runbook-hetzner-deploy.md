# Runbook: Hetzner Initial-Deploy + Updates

> **Status:** Ready
> **Letzte Verifikation:** 2026-05-13
> **Estimated time:** 45-60 min (Initial-Deploy) / 5-10 min (Update)

Operations-Runbook fuer mcp-approval2 auf Hetzner Cloud CX21
(Single-VM-Pilot, EU-Frankfurt, docker-compose-Stack).

## Voraussetzungen

- **Hetzner Cloud Account** mit Project + API-Token (Read+Write Scope)
  - Console → Security → API Tokens → "Generate API Token"
- **Cloudflare Account** mit:
  - Zone `ai-toolhub.org` bereits konfiguriert (terraform-managed)
  - API-Token mit Permissions: `Zone:Read`, `DNS:Edit` fuer die Zone
- **SSH-Key** (ED25519 empfohlen) — `ssh-keygen -t ed25519 -C "operator@mcp-approval2"`
- **Lokale Tools:**
  - `terraform >= 1.6`
  - `hcloud` CLI (optional, fuer Debugging)
  - `dig` / `curl` fuer DNS + Smoke-Tests
- **Repo-Clone** `/workspaces/mcp-approval2` (oder lokal)
- **R2-Backend-Credentials** (gleicher Bucket wie `mcp-approval/terraform/`)

## Schritte

### 1. Terraform-Bootstrap

```bash
cd /workspaces/mcp-approval2/terraform/environments/privat

# Provider initialisieren + R2-Backend
terraform init

# Variablen pruefen (terraform.tfvars NICHT committed, lokal anlegen)
cat > terraform.tfvars <<'EOF'
instance_name          = "mcp-approval2-privat"
operator_ssh_public_key = "ssh-ed25519 AAAA... operator@mcp-approval2"
allowed_ssh_ips        = ["1.2.3.4/32"]   # eigene IPv4
domain_mcp             = "mcp2.ai-toolhub.org"
domain_knowledge       = "knowledge2.ai-toolhub.org"
domain_app             = "app2.ai-toolhub.org"
hcloud_token           = "..."
cloudflare_api_token   = "..."
cloudflare_zone_id     = "..."
EOF

terraform plan
terraform apply
```

Erwartetes Output:
- 1× `hcloud_server` (CX21, Frankfurt, Ubuntu 24.04)
- 1× `hcloud_firewall` mit Rules :22 (operator-IP), :80, :443 (world)
- 1× `hcloud_volume` (20 GB)
- 3× `cloudflare_dns_record` (A-Records mcp2/knowledge2/app2)
- Output: `vm_ipv4`, `vm_ipv6`

### 2. DNS-Propagation pruefen

```bash
dig +short mcp2.ai-toolhub.org
dig +short knowledge2.ai-toolhub.org
dig +short app2.ai-toolhub.org
```

Erwartetes Output: alle drei zeigen auf `vm_ipv4` aus Terraform-Output.

### 3. VM-Setup (SSH)

```bash
VM_IP=$(terraform output -raw vm_ipv4)
ssh deploy@${VM_IP}

# auf VM:
cd /opt
sudo git clone https://github.com/axel-rogg/mcp-approval2.git
sudo chown -R deploy:deploy mcp-approval2
cd mcp-approval2
```

Erwartetes Output: cloud-init hat bereits docker + git + ufw + fail2ban installiert.
Check via `docker --version` (≥ 24) + `docker compose version` (≥ v2).

### 4. Secrets generieren + .env editieren

```bash
cd /opt/mcp-approval2/deploy/hetzner
bash generate-secrets.sh > .env
chmod 600 .env

# Manuell ergaenzen:
# - GOOGLE_OAUTH_CLIENT_ID / SECRET (aus GCP Console)
# - VERTEX_AI_PROJECT_ID
# - Domain-Variablen (APPROVAL_DOMAIN=mcp2.ai-toolhub.org etc.)
nano .env
```

Erwartetes Output: `.env` enthaelt
`POSTGRES_PASSWORD`, `VAULT_TOKEN` (kommt erst nach vault-init), `JWT_RS256_*`,
`MCP_APPROVAL_INTERNAL_TOKEN`, `KNOWLEDGE_MASTER_KEY_BASE64`,
`APPROVAL_DOMAIN`, `KNOWLEDGE_DOMAIN`, `APP_DOMAIN`.

### 5. Initial-Stack-Start

```bash
cd /opt/mcp-approval2/deploy/hetzner
bash setup.sh
```

Was setup.sh macht:
1. `docker compose pull` (Images von ghcr.io ziehen)
2. `docker compose up -d postgres openbao` (DB + Vault zuerst)
3. `bash vault-init.sh` → schreibt unseal-keys + root-token nach
   `/opt/mcp-approval2/.vault-init-output` (3 Keys, Threshold 2)
4. **WICHTIG:** unseal-keys + root-token sofort offline backupen
   (Paper-Wallet oder verschluesselter USB-Stick), dann
   `shred -u /opt/mcp-approval2/.vault-init-output`
5. `VAULT_TOKEN` in `.env` setzen
6. `docker compose up -d` (alle Services)
7. `docker compose exec mcp-approval2 node scripts/migrate.js`
8. `docker compose exec mcp-knowledge2 node scripts/migrate.js`

Erwartetes Output: alle 5 Services running (`docker compose ps`).

### 6. Smoke-Test

```bash
cd /opt/mcp-approval2/deploy/hetzner
bash healthcheck.sh
```

Erwartetes Output:
```
[OK] postgres        healthy
[OK] openbao         unsealed
[OK] mcp-approval2   /health 200
[OK] mcp-knowledge2  /health 200
[OK] caddy           SSL active
```

Zusaetzliche manuelle Checks:

```bash
# vom lokalen Rechner (NICHT auf VM)
curl -sI https://mcp2.ai-toolhub.org/health
# Expect: HTTP/2 200 + valid Lets-Encrypt cert

curl -sI https://knowledge2.ai-toolhub.org/health
# Expect: HTTP/2 200

curl -sI https://app2.ai-toolhub.org/
# Expect: HTTP/2 200, PWA HTML
```

### 7. First-User-Onboarding

```
Browser → https://app2.ai-toolhub.org
→ Google-OAuth-Login (erster User wird automatisch Admin)
→ Passkey enrollen
→ /v1/admin/invites fuer weitere User
```

Detailliert in [runbook-pilot-onboarding.md](runbook-pilot-onboarding.md).

## Updates-Routine

Fuer Code-Updates nach Initial-Deploy:

```bash
ssh deploy@${VM_IP}
cd /opt/mcp-approval2
bash deploy/hetzner/update.sh
```

Was update.sh macht:
1. `git pull --rebase origin main`
2. `docker compose -f deploy/hetzner/docker-compose.yml pull`
3. `docker compose -f deploy/hetzner/docker-compose.yml up -d` (rolling)
4. `docker compose exec mcp-approval2 node scripts/migrate.js` (nur wenn Migrations gepullt)
5. Smoke `bash deploy/hetzner/healthcheck.sh`

Erwartetes Output: alle Services restart, kein Downtime > 30s pro Service
(Caddy macht graceful-reload, mcp-approval2 hat Health-Probe).

## Logs einsehen

```bash
# Live-Tail des Haupt-Services
docker compose -f deploy/hetzner/docker-compose.yml logs -f mcp-approval2

# Letzte 100 Zeilen alle Services
docker compose -f deploy/hetzner/docker-compose.yml logs --tail=100

# Caddy / SSL-Issues
docker compose -f deploy/hetzner/docker-compose.yml logs caddy

# Postgres slow-query
docker compose -f deploy/hetzner/docker-compose.yml logs postgres
```

## Troubleshooting

- **Problem:** `terraform apply` failed mit `403 invalid hcloud token`
  → **Loesung:** Token-Scope pruefen (Read+Write), `export HCLOUD_TOKEN=...`
    statt in tfvars (Security-Hygiene).

- **Problem:** DNS-Records propagieren nicht (dig liefert NXDOMAIN)
  → **Loesung:** CF-Cache pruefen, 5 min warten, dann
    `cloudflare_dns_record` Zone-ID pruefen.

- **Problem:** `bash setup.sh` haengt bei `vault-init`
  → **Loesung:** `docker compose logs openbao` checken, evtl. file-backend
    Permission-Issue (`/vault/data` muss vault:vault gehoeren).

- **Problem:** Caddy zeigt SSL-Cert-Error im Browser
  → **Loesung:** DNS muss vorher propagiert sein (Schritt 2). Lets-Encrypt
    HTTP-01-Challenge braucht funktionierende DNS-Resolution.
    Logs: `docker compose logs caddy | grep -i "certificate"`.

- **Problem:** mcp-approval2 503 obwohl Container running
  → **Loesung:** Vault sealed? `docker compose exec openbao bao status`.
    Falls sealed → unseal via 2 von 3 Keys aus offline-backup.

- **Problem:** Update wirft `migration error: relation already exists`
  → **Loesung:** Drizzle-Migration-State out-of-sync. Pruefen via
    `docker compose exec postgres psql -U app -d approval2 -c "SELECT * FROM drizzle_migrations"`,
    dann manuell die fehlende Migration-Row erzeugen ODER
    bei Test-Pilot DB neu seeden.

- **Problem:** `git pull` schlaegt fehl wegen lokal staged changes (`.env`)
  → **Loesung:** `.env` ist in `.gitignore` — wenn doch geaendert ist es
    eine Local-Override, mit `git stash` schuetzen, `update.sh` laufen,
    `git stash pop` zurueck.

## Verifikation

Nach Initial-Deploy oder grossem Update:

- [ ] `bash healthcheck.sh` zeigt alle Services OK
- [ ] `curl https://mcp2.ai-toolhub.org/health` liefert 200
- [ ] `curl https://app2.ai-toolhub.org/` liefert PWA-HTML
- [ ] First-Admin-Login via OAuth funktioniert
- [ ] Passkey-Enrollment laeuft durch (WebAuthn)
- [ ] `docker compose logs --tail=50` keine ERROR-Lines
- [ ] SSL-Cert ist valid (`curl -vI` zeigt Lets-Encrypt-Issuer)

## Referenzen

- [PLAN-hetzner-deployment §6](../plans/active/PLAN-hetzner-deployment.md#6-setup-schritte-operator-workflow)
- [PLAN-hetzner-deployment §7](../plans/active/PLAN-hetzner-deployment.md#7-operations-runbooks-siehe-docsrunbooks)
- [runbook-pilot-onboarding.md](runbook-pilot-onboarding.md) — User-Side
- [runbook-hetzner-backup-restore.md](runbook-hetzner-backup-restore.md)
- [runbook-hetzner-disaster-recovery.md](runbook-hetzner-disaster-recovery.md)
