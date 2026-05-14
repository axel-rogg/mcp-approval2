# Runbook: Doppler — Single-Source-of-Truth für Secrets

**Status:** ✅ Aktiv ab 2026-05-14
**Scope:** Komplette Secret-Verwaltung von mcp-approval2 (lokal, GH-Actions,
Hetzner-VM, später GCP-Business).

> **Warum Doppler?**
> Vor der Migration verteilten sich Secrets über 4 Orte: `.dev.vars`,
> `terraform.tfvars`, GitHub-Secrets, VM-`.env`. Rotation hieß: an 4 Stellen
> ändern, an 4 Stellen vergessen.
> Mit Doppler gibt es **einen** Speicherort. Alle 4 Surfaces ziehen
> automatisch nach: `doppler run` für Terraform/local, der
> Doppler→GitHub-Sync für CI, `scripts/doppler-vm-sync.sh` für die VM.

---

## Phasen-Übersicht

| Phase | Dauer | Aktivität | Wer macht es |
|---|---|---|---|
| 1 | 1 min | Doppler-Account + Personal-Token | Operator |
| 2 | 5 min | Terraform `apply` (Project + Configs + Service-Tokens) | Operator |
| 3 | 15-30 min | Secret-Werte im Doppler-UI eintragen | Operator |
| 4 | 2 min | Doppler→GitHub-Sync aktivieren | Operator |
| 5 | dauerhaft | `doppler run` für lokale Operations | Alle |
| 6 | bei VM-Deploy | VM-Sync via Token-File | Operator |
| 7 | quartalsweise | Token- + Secret-Rotation | Operator |

---

## Phase 1 — Doppler-Account-Setup (1 min)

1. **Account anlegen** auf <https://www.doppler.com/> (Free-Plan reicht für
   Single-Workplace).
2. **Personal-Token generieren:**
   - Avatar (oben rechts) → **Profile** → **Personal Tokens**.
   - Neuen Token erzeugen mit Scope `workplace:admin`.
   - Wert sofort kopieren — wird nur einmal angezeigt.
3. **Token lokal hinterlegen** in `/workspaces/mcp-approval2/.dev.vars`
   (gitignored):

   ```
   DOPPLER_TOKEN=dp.pt.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

   > Das ist der **Personal**-Token (`dp.pt.…`) — nicht zu verwechseln mit
   > den späteren Service-Tokens (`dp.st.…`) die Terraform erzeugt.

---

## Phase 2 — Terraform-Apply (Project + Configs + Placeholders) (5 min)

Das `doppler-setup`-Modul legt im Doppler-Workplace an:
- Project `mcp-approval2`
- 3 Configs: `dev` / `privat` / `business`
- 28 Secret-Placeholders (leere Werte, in Phase 3 zu füllen)
- 2 Service-Tokens: für VM und für GH-Actions

```bash
# 1. .dev.vars laden (enthält DOPPLER_TOKEN aus Phase 1)
cd /workspaces/mcp-approval2
set -a && source .dev.vars && set +a

# 2. In das privat-Environment wechseln
cd terraform/environments/privat

# 3. Init + apply (legt das Doppler-Project + Configs an)
terraform init
terraform apply -target='module.doppler'
```

Erwartete Outputs:
- `doppler_dashboard_url` → Direkt-Link zum frisch angelegten Project
- `hetzner_vm_service_token` (sensitive) → für Phase 6
- `github_actions_service_token` (sensitive) → wird von `module.github`
  automatisch konsumiert beim nächsten Apply

> **Hinweis:** Der zweite `terraform apply` (ohne `-target`) wird
> `module.github` konvergieren und den GH-Actions-Service-Token als
> `DOPPLER_TOKEN_GHA` ins Repo pushen. Das geht in dieser Phase noch nicht
> ohne weiteres durch, weil die anderen 28 Secrets im Doppler-Project
> noch leer sind — der GH-Sync (Phase 4) zwingt aber nicht zur
> Vollständigkeit, weil leere Werte einfach als leere Strings landen.

---

## Phase 3 — Secrets im Doppler-UI manuell befüllen (15-30 min)

Öffne <https://dashboard.doppler.com/workplace/projects/mcp-approval2/configs/privat>.

Die 28 Placeholders sind nach Themen sortiert. Hier die Quellen-Map:

### 3.1 Aus dem alten `.dev.vars` (mcp-approval Repo) übernehmen

| Secret-Name | Quelle (in mcp-approval/.dev.vars) | Notiz |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | gleicher Name | Scope: Zone:DNS:Edit + Worker-Routes |
| `CLOUDFLARE_ZONE_ID` | gleicher Name | 32-char hex |
| `HCLOUD_TOKEN` | gleicher Name | Project-scoped Read+Write |
| `R2_ACCESS_KEY_ID` | gleicher Name | für TF-State + Backups |
| `R2_SECRET_ACCESS_KEY` | gleicher Name | Pair zu R2-Access-Key |
| `OPERATOR_SSH_PUBLIC_KEY` | aus `~/.ssh/id_ed25519.pub` | One-line OpenSSH |
| `HETZNER_DEPLOY_SSH_PRIVATE_KEY` | separat erzeugen (`ssh-keygen -t ed25519`) | NICHT der Operator-Key |
| `MCP_APPROVAL_INTERNAL_TOKEN` | `openssl rand -hex 32` | Internal-Service-Token |
| `GHCR_TOKEN` | optional, GitHub-PAT scope `read:packages` | leer lassen wenn ghcr-public |

### 3.2 Aus Google Cloud Console (OAuth)

| Secret-Name | Wo holen |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | Cloud-Console → APIs & Services → Credentials → OAuth-Client |
| `GOOGLE_OAUTH_CLIENT_SECRET` | dito |
| `GOOGLE_OAUTH_REDIRECT_URI` | z.B. `https://app2.ai-toolhub.org/oauth/google/callback` |
| `GOOGLE_WORKSPACE_OAUTH_CLIENT_ID` | separater Client für GWS-Tools |
| `GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET` | dito |

### 3.3 Domain-FQDNs (Default-Werte ok)

| Secret-Name | Standardwert |
|---|---|
| `DOMAIN_MCP` | `mcp2.ai-toolhub.org` |
| `DOMAIN_KNOWLEDGE` | `knowledge2.ai-toolhub.org` |
| `DOMAIN_APP` | `app2.ai-toolhub.org` |

### 3.4 Later — werden erst nach Phase 6 von der VM gestempelt

| Secret-Name | Quelle |
|---|---|
| `HETZNER_VM_HOST` | `terraform output vm_ipv4` nach Phase 6 |
| `WEBAUTHN_RP_ID` | = `DOMAIN_APP` ohne Schema |
| `POSTGRES_PASSWORD` | von `generate-secrets.sh` |
| `JWT_SECRET` | von `generate-secrets.sh` |
| `VAULT_UNSEAL_KEY` | von `vault-init.sh` auf der VM (NICHT in Doppler bis sicher) |

> **Tipp:** Die "later"-Felder kannst du in Phase 3 leer lassen. Doppler
> zeigt sie dann mit dem Badge "empty" — beim VM-Setup in Phase 6
> stempelst du sie via `doppler secrets set` ins Doppler-Project.

---

## Phase 4 — Doppler→GitHub-Actions-Sync aktivieren (2 min)

Damit GH-Workflows keine 13 hartcodierten Secrets mehr brauchen, sondern
Doppler den `hetzner-production`-Environment automatisch füllt:

1. Öffne <https://dashboard.doppler.com/workplace/projects/mcp-approval2>
2. Tab **Integrations** → Suche `GitHub Actions` → **Connect**.
3. Autorisiere die Doppler-GitHub-App für den User `axel-rogg` (oder die
   Org, falls das Repo mal umgezogen wird).
4. Sync-Mode: **Per Environment**.
5. Mapping:
   - Doppler-Config `privat` → GitHub-Environment `hetzner-production`
6. **Save**.

Doppler pushed jetzt automatisch alle Secrets vom Privat-Config in den
GH-Environment, inkl. zukünftiger Adds. Der einzige Secret, den
Terraform direkt setzt, ist `DOPPLER_TOKEN_GHA` (+ env-mirror
`DOPPLER_TOKEN`) — Chicken-Egg, weil Workflows ihn brauchen um
überhaupt mit Doppler zu sprechen.

```bash
# Apply jetzt den github-Modul-Teil, damit DOPPLER_TOKEN_GHA in GH landet:
cd terraform/environments/privat
terraform apply -target='module.github'
```

**Verifikation:** Im GitHub-Repo unter
<https://github.com/axel-rogg/mcp-approval2/settings/secrets/actions>
sollten zu sehen sein:
- Repo-Secrets: `DOPPLER_TOKEN_GHA`
- Environment `hetzner-production`: `DOPPLER_TOKEN` + alle 28 Sync-Secrets

---

## Phase 5 — Doppler lokal nutzen (Operations)

Einmaliges Setup auf dem Entwickler-Rechner:

```bash
# Repo-Bootstrap (installs doppler-cli, maps the cwd to mcp-approval2/privat)
bash scripts/doppler-bootstrap.sh
```

Danach im Daily-Use:

```bash
# Terraform mit Doppler-Env (statt terraform.tfvars / set -a)
doppler run -- terraform plan
doppler run -- terraform apply

# Tests mit Doppler-Env
doppler run -- npm test
doppler run -- bash scripts/pilot-smoke.sh

# Einzelnen Wert abfragen (read-only, nicht in History loggen)
doppler secrets get HCLOUD_TOKEN --plain
```

> `doppler run` injiziert alle Secrets als ENV-Vars in den Sub-Prozess.
> Die Werte landen NICHT in der Shell-History oder im Shell-Env des
> Aufrufers — nur im Child-Prozess. Genau das Verhalten das wir
> für Token-Hygiene wollen.

---

## Phase 6 — VM-Sync nach Deploy

Auf dem **Operator-Host** (nicht der VM):

```bash
cd terraform/environments/privat
terraform output -raw doppler_vm_token
# Output: dp.st.privat.AAAAA...    (kopieren, NICHT loggen)
```

Auf der **VM** als `deploy`-User:

```bash
ssh deploy@<VM_IP>

# 1) Token-File anlegen (chmod 600 ist Pflicht — read-only der Welt!)
echo 'dp.st.privat.AAAAA...' > /opt/mcp-approval2/.doppler-token
chmod 600 /opt/mcp-approval2/.doppler-token

# 2) Erst-Sync — schreibt .env nach /opt/mcp-approval2/deploy/hetzner/.env
bash /opt/mcp-approval2/scripts/doppler-vm-sync.sh

# 3) Stack hochfahren
cd /opt/mcp-approval2/deploy/hetzner
bash setup.sh
```

`setup.sh` ist Doppler-aware: wenn die Token-Datei existiert, ruft es
`scripts/doppler-vm-sync.sh` selbst auf bevor `docker compose up` läuft.
Du kannst ab Phase 6 also auch nach jedem Reboot einfach
`bash setup.sh` rufen — sync passiert automatisch.

### VM-Sync regelmäßig (optional)

Wer Secret-Rotation in <60 s auf der VM sehen will: systemd-Timer.

```ini
# /etc/systemd/system/doppler-sync.service
[Unit]
Description=Sync Doppler secrets to .env
After=network-online.target

[Service]
Type=oneshot
User=deploy
ExecStart=/bin/bash /opt/mcp-approval2/scripts/doppler-vm-sync.sh
ExecStartPost=/usr/bin/docker compose -f /opt/mcp-approval2/deploy/hetzner/docker-compose.yml up -d
```

```ini
# /etc/systemd/system/doppler-sync.timer
[Unit]
Description=Hourly Doppler secrets sync

[Timer]
OnBootSec=2min
OnUnitActiveSec=1h

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now doppler-sync.timer
```

---

## Phase 7 — Rotation + Multi-Instance

### 7.1 Einzelnen Wert rotieren (z.B. HCLOUD_TOKEN abgelaufen)

```bash
# Im Doppler-UI ODER via CLI
doppler secrets set HCLOUD_TOKEN='<neuer-wert>' --config privat

# Sync läuft danach automatisch:
#   - GH-Actions: Doppler pushed in <60s
#   - VM:         beim nächsten systemd-Timer-Tick ODER:
#                 ssh deploy@vm 'bash /opt/mcp-approval2/scripts/doppler-vm-sync.sh'
#                 ssh deploy@vm 'cd /opt/mcp-approval2/deploy/hetzner && docker compose up -d'
#   - Lokal:      sofort via `doppler run`
```

Kein `terraform apply` nötig.

### 7.2 Service-Token rotieren (quartalsweise)

```bash
# Service-Token sind in module.doppler — taint + apply:
cd terraform/environments/privat
terraform taint 'module.doppler.doppler_service_token.github_actions'
terraform apply -target='module.doppler.doppler_service_token.github_actions'
terraform apply -target='module.github'   # pushed neuen Wert in GH-Secrets

# VM-Token analog
terraform taint 'module.doppler.doppler_service_token.hetzner_vm'
terraform apply -target='module.doppler.doppler_service_token.hetzner_vm'
terraform output -raw doppler_vm_token    # in VM-Token-File schreiben (Phase 6)
```

### 7.3 Multi-Instance (Business-Config aktivieren)

Wenn die GCP-Business-Instance kommt:

1. `terraform apply` mit `create_business_environment = true` in
   `environments/privat/github.tf` (oder neuer `environments/business/`).
2. Im Doppler-UI: Project `mcp-approval2` → Config `business` → Werte
   eintragen (kann unabhängig von `privat` divergieren — andere Zone-ID,
   andere Domain, etc.).
3. Im GitHub-Sync: zusätzliches Mapping `business` → `gcp-business`
   anlegen.

---

## Anhang: Was ist wo

| Surface | Wer schreibt | Wer liest | Sync-Lag |
|---|---|---|---|
| Doppler-UI / API | Operator (manuell) + `module.doppler` (TF Placeholders) | alle Targets | — |
| Lokale Shell | `doppler run -- ...` injiziert | Terraform, npm, scripts | sofort |
| GitHub-Actions | Doppler-Sync (automatisch) | Workflows | <60s |
| Hetzner-VM | `scripts/doppler-vm-sync.sh` (manuell + systemd-Timer) | docker-compose `.env` | 1h via Timer, sonst manuell |

## Anhang: Files

- Module: [terraform/modules/doppler-setup/](../../terraform/modules/doppler-setup/)
- GH-Repo-Modul (reduced): [terraform/modules/github-repo/secrets.tf](../../terraform/modules/github-repo/secrets.tf)
- Env-Wiring: [terraform/environments/privat/github.tf](../../terraform/environments/privat/github.tf)
- Bootstrap: [scripts/doppler-bootstrap.sh](../../scripts/doppler-bootstrap.sh)
- VM-Sync: [scripts/doppler-vm-sync.sh](../../scripts/doppler-vm-sync.sh)
- Cloud-Init: [deploy/hetzner/cloud-init.yaml.tpl](../../deploy/hetzner/cloud-init.yaml.tpl)
- Setup: [deploy/hetzner/setup.sh](../../deploy/hetzner/setup.sh)
