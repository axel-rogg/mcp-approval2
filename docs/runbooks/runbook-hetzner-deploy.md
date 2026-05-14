# Runbook: Hetzner Initial-Deploy + Updates

> **Status:** Ready
> **Letzte Verifikation:** 2026-05-14 (post-audit)
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

### 1. Terraform-Bootstrap (Doppler-driven, no tfvars)

Voraussetzung: `bash scripts/doppler-bootstrap.sh` einmalig ausfuehren +
Doppler-Config `privat` mit `bash scripts/doppler-seed-secrets.sh` befuellen
(siehe [runbook-doppler.md](runbook-doppler.md) Phase 3).

```bash
cd /workspaces/mcp-approval2

# Wrapper liest alle Secrets aus Doppler, mappt auf TF_VAR_* +
# provider-native ENV-Vars, exect terraform. Kein terraform.tfvars
# noetig — Werte leben ausschliesslich in Doppler.
bash scripts/doppler-run-terraform.sh init     # einmalig pro Maschine
bash scripts/doppler-run-terraform.sh plan
bash scripts/doppler-run-terraform.sh apply
```

Erwartetes Output:
- 1× `hcloud_server` (CX21, Frankfurt, Ubuntu 24.04) mit `prevent_destroy=true`
- 1× `hcloud_firewall` mit Rules :22 (default 0.0.0.0/0, Key-only + fail2ban),
  :80, :443 (world), ICMP
- 0..1× `hcloud_volume` (default 0 GB = disabled; aktivieren via Doppler-Var
  `data_volume_size_gb`) — falls aktiv: ebenfalls `prevent_destroy=true`
- 6× `cloudflare_dns_record` (A + AAAA fuer mcp2/knowledge2/app2)
- 1× GitHub-Repo-Settings (Branch-Protection, Environments, Doppler-Token-Secret)
- 2× Doppler-Service-Tokens (VM + GH-Actions, sensitive Outputs)
- Output: `vm_ipv4`, `vm_ipv6`, `default_hetzner_fqdn_v4`, `coop_bypass_url`,
  `allowed_origins_csv`

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

### 4. Secrets-Quelle waehlen — Doppler ODER lokale generate-secrets.sh

**Empfohlen: Doppler-VM-Sync.** Token-File einmalig deponieren, danach
holt sich die VM `.env` selbst:

```bash
# Operator-Host:
cd /workspaces/mcp-approval2/terraform/environments/privat
bash /workspaces/mcp-approval2/scripts/doppler-run-terraform.sh \
  output -raw doppler_vm_token  # NICHT loggen, direkt in ssh-pipe

# VM (als deploy-User):
echo 'dp.st.privat.XXX' > /opt/mcp-approval2/.doppler-token
chmod 600 /opt/mcp-approval2/.doppler-token
bash /opt/mcp-approval2/scripts/doppler-vm-sync.sh   # schreibt .env
```

**Fallback: lokal generieren** (wenn Doppler noch nicht eingerichtet):

```bash
cd /opt/mcp-approval2/deploy/hetzner
bash generate-secrets.sh > .env
chmod 600 .env

# Manuell ergaenzen / pruefen:
# - GOOGLE_OAUTH_CLIENT_ID + SECRET (aus GCP Console)
# - VERTEX_AI_PROJECT_ID (optional)
# - ALLOWED_EMAILS (CSV, Whitelist fuer Google-OAuth-Login)
# - ALLOWED_ORIGINS (CSV — Pflicht fuer Coop-Bypass / app2.ai-toolhub.org)
nano .env
```

`.env` enthaelt nach Generate / Doppler-Sync u.a.:
- **Generated:** `POSTGRES_PASSWORD`, `MCP_APPROVAL_INTERNAL_TOKEN`,
  `JWT_RS256_PRIVATE_KEY_PEM` + `_PUBLIC_KEY_PEM`, `JWT_KID`,
  `JWT_SECRET` (HS256 fuer Sessions + OAuth-tokens),
  `MASTER_KEY_BASE64` (KEK fuer Credential-Encrypt),
  `KNOWLEDGE_BACKUP_MASTER_KEY_BASE64`, `VAPID_*`, `HETZNER_DEPLOY_SSH_PRIVATE_KEY`
- **Operator fuellt:** `VAULT_TOKEN` (nach `vault-init.sh`), `GOOGLE_OAUTH_*`,
  `ALLOWED_EMAILS`, `ALLOWED_ORIGINS`, `VERTEX_AI_*`
- **Domain-Defaults:** `DOMAIN_MCP`, `DOMAIN_KNOWLEDGE`, `DOMAIN_APP`

**Warum JWT_SECRET + MASTER_KEY_BASE64 Pflicht sind:**
[apps/server/src/lib/config.ts](../../apps/server/src/lib/config.ts) verlangt
`JWT_SECRET ≥ 32 chars` (HS256-Pfad: `auth/session/issuer.ts`,
`mcp/oauth/token.ts`, `routes/internal/credentials.ts`). Ohne
`MASTER_KEY_BASE64` faellt der KEK-Provider auf "no-credentials-mode" zurueck
(`index.ts:69-77`) — alle `/v1/credentials/*` + GDPR-Routes bleiben
unmontiert. Audit-Finding #1 + #4 (2026-05-14).

### 5. Initial-Stack-Start

```bash
cd /opt/mcp-approval2/deploy/hetzner
bash setup.sh
```

Was setup.sh macht:
1. Doppler-Sync (falls Token-File da) → schreibt aktuelles `.env`
2. `docker compose pull` (Images von ghcr.io ziehen)
3. `docker compose up -d postgres openbao` (DB + Vault zuerst)
4. `bash vault-init.sh` → schreibt unseal-keys + root-token nach
   `/opt/mcp-approval2/.vault-init-output` (3 Keys, Threshold 2)
5. **WICHTIG:** unseal-keys + root-token sofort offline backupen
   (Paper-Wallet oder verschluesselter USB-Stick), dann
   `shred -u /opt/mcp-approval2/.vault-init-output`
6. `VAULT_TOKEN` in Doppler (oder `.env`) setzen
7. `docker compose up -d` (alle Services)
8. `docker compose exec -T mcp-approval2 npx tsx scripts/migrate.ts` — **fail-fast**, kein
   `|| echo WARN` mehr. Falls hier abbricht: `docker compose logs mcp-approval2`.
9. `docker compose exec -T mcp-knowledge2 npx tsx scripts/migrate.ts`

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
2. Doppler-Sync (falls Token-File da) → `.env` aktualisiert
3. `docker compose -f deploy/hetzner/docker-compose.yml pull`
4. `docker compose -f deploy/hetzner/docker-compose.yml up -d` (rolling)
5. `docker compose exec -T mcp-approval2 npx tsx scripts/migrate.ts` — fail-fast
6. `docker compose exec -T mcp-knowledge2 npx tsx scripts/migrate.ts` — fail-fast
7. Smoke `bash deploy/hetzner/healthcheck.sh`

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

- **Problem:** `terraform destroy` failed mit
  `Resource has prevent_destroy lifecycle = true`
  → **Loesung:** Schutz ist Absicht (Audit-Finding #1, 2026-05-14). VM +
    Volume halten User-Daten / pgdata. Echtes Destroy:
    1. In [terraform/modules/hetzner-mcp-instance/main.tf](../../terraform/modules/hetzner-mcp-instance/main.tf)
       `lifecycle { prevent_destroy = true }` auskommentieren.
    2. `bash scripts/doppler-run-terraform.sh apply` (state-update).
    3. `bash scripts/doppler-run-terraform.sh destroy`.
    4. Block wieder rein-committen damit das Loch nicht offen bleibt.

- **Problem:** Container bootet mit `ZodError: JWT_SECRET must be >= 32 chars`
  → **Loesung:** `JWT_SECRET` fehlt in `.env`. Entweder via Doppler
    (`doppler secrets get JWT_SECRET --plain -p mcp-approval2 -c privat`)
    nachsehen / via `doppler-seed-secrets.sh` neu generieren, oder
    `openssl rand -hex 32` lokal in `.env` setzen. Audit-Finding #1.

- **Problem:** `/v1/credentials/*` antwortet 404
  → **Loesung:** `MASTER_KEY_BASE64` fehlt — Server faellt auf
    no-credentials-mode zurueck und mountet die Credential-Routes nicht
    ([apps/server/src/index.ts:69-77](../../apps/server/src/index.ts#L69)).
    Logs: `[mcp-approval2] credentials=off ...`. Fix: 32 Bytes base64 in
    Doppler oder `.env` setzen.

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
