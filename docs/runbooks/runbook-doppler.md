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
- 2 Configs: `dev` / `privat` (business removed 2026-05-14 — Decision: keine
  Business-Credentials in Doppler)
- 33 Secret-Placeholders (leere Werte, in Phase 3 zu füllen / vom Seed-
  Script automatisch befüllt)
- 2 Service-Tokens: für VM und für GH-Actions

```bash
# 1. Erst-Apply legt das Doppler-Project + Configs + leere Placeholders an.
#    Der doppler-run-terraform.sh-Wrapper liest DOPPLER_TOKEN aus .dev.vars,
#    mappt Secrets auf TF_VAR_* + provider-native ENV-Vars.
cd /workspaces/mcp-approval2
bash scripts/doppler-run-terraform.sh init
bash scripts/doppler-run-terraform.sh apply -target='module.doppler'

# 2. Initial-Seed: Crypto-Keys + Random-Tokens generieren und in das
#    privat-Config schreiben (Gruppe A aus altem .dev.vars, Gruppe B frisch).
#    Idempotent — re-run sicher, bestehende Werte werden ueberschrieben.
bash scripts/doppler-seed-secrets.sh
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

Öffne <https://dashboard.doppler.com/projects/mcp-approval2/configs/privat>.

Die 33 Placeholders sind nach Themen sortiert. **Viele füllt das Seed-Script
aus Phase 2 automatisch** — die Tabelle markiert, was du noch manuell machen
musst. Hier die Quellen-Map:

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

### 3.4 Vom Seed-Script (Phase 2) befüllt — nichts zu tun

`scripts/doppler-seed-secrets.sh` schreibt diese Werte automatisch:

| Secret-Name | Inhalt |
|---|---|
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `MCP_APPROVAL_INTERNAL_TOKEN` | `openssl rand -hex 32` |
| `JWT_SECRET` | `openssl rand -hex 32` (HS256, Sessions + OAuth-tokens) |
| `MASTER_KEY_BASE64` | `openssl rand 32 \| base64` (KEK fuer Credential-Encrypt) |
| `JWT_RS256_PRIVATE_KEY_PEM` + `_PUBLIC_KEY_PEM` + `JWT_KID` | RSA-2048 keypair |
| `KNOWLEDGE_BACKUP_MASTER_KEY_BASE64` | 32 raw bytes base64 |
| `VAPID_PRIVATE_KEY` + `VAPID_PUBLIC_KEY` | P-256 fuer Web-Push |
| `OPERATOR_SSH_PUBLIC_KEY` | aus `~/.ssh/id_ed25519.pub` (oder id_rsa.pub) |
| `HETZNER_DEPLOY_SSH_PRIVATE_KEY` | frisch generiert fuer GH-Actions |
| `ACME_EMAIL` | aus `git config user.email` |

### 3.5 Werden erst von der VM gefüllt

| Secret-Name | Quelle |
|---|---|
| `HETZNER_FQDN_V4` | `terraform output -raw default_hetzner_fqdn_v4` nach Phase 6 |
| `ALLOWED_ORIGINS` | `terraform output -raw allowed_origins_csv` nach Phase 6 |
| `VAULT_TOKEN` | von `vault-init.sh` auf der VM (Root-Token, NICHT in Doppler bis nach Audit) |

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
# Terraform: doppler-run-terraform.sh Wrapper (NICHT plain `doppler run`).
#   Mappt Doppler-Namen auf TF_VAR_* + provider-native ENV-Vars (HCLOUD_TOKEN,
#   CLOUDFLARE_API_TOKEN, GITHUB_TOKEN, AWS_* fuer R2-Backend), cd in
#   environments/privat, exec terraform.
bash scripts/doppler-run-terraform.sh plan
bash scripts/doppler-run-terraform.sh apply

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

### Neue Placeholder hinzufuegen (chicken-and-egg)

Wenn du ein neues `doppler_secret` in `modules/doppler-setup/main.tf`
ergaenzt **und** den Wert vorher schon im Doppler-UI / via CLI gesetzt
hast: `terraform apply` wuerde versuchen den Wert auf `""` zu setzen
(Create-Phase nutzt den `value`-Arg, `ignore_changes` greift erst danach).

Loesung: **erst importieren, dann apply**:

```bash
bash scripts/doppler-run-terraform.sh import \
  "module.doppler.doppler_secret.placeholder_<name>" \
  "mcp-approval2.privat.<SECRET_NAME>"

bash scripts/doppler-run-terraform.sh plan   # sollte jetzt no-op fuer das Secret
```

Beispiel-Workflow fuer JWT_SECRET + MASTER_KEY_BASE64 (2026-05-14
Pre-Deploy-Audit): Secrets via `openssl rand` ins Doppler-Config gesetzt,
Resource-Blocks in `main.tf` ergaenzt, dann `terraform import` fuer beide,
dann `apply` → keine Drift.

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

> **Stand 2026-05-14:** Business-Environment wurde aus dem Doppler-Modul
> entfernt (User-Decision: keine Business-Credentials in Doppler).
> Wenn die GCP-Business-Instance kommt, eigenes Setup ohne Doppler-Mirror
> oder separater Doppler-Workplace.

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
