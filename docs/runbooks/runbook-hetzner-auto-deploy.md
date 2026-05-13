# Runbook: Hetzner Auto-Deploy

> Operations-Doku für den GitHub-Actions-basierten Auto-Deploy-Pfad zur
> Hetzner-VM. Ergänzt [runbook-hetzner-deploy.md](runbook-hetzner-deploy.md)
> (manueller Deploy) um SSH-Auto-Deploy + Watchtower-Image-Updates.

## Übersicht

Die Hetzner-VM bekommt Updates über **drei Pfade**:

| Pattern | Was es macht | Wann nutzen |
|---|---|---|
| **Watchtower** (auto) | Pulls neue Container-Image-Tags alle 5 min von ghcr.io | Default — passiert ohne Aktion bei jedem Image-Push |
| **GitHub Actions Auto-Deploy** | git pull + Migrations + Stack-Restart via SSH | Bei Code-Changes außerhalb von Images (Migration, `deploy/hetzner/*`, Caddyfile, docker-compose.yml) |
| **Manual `update.sh`** | Gleiches wie GH-Actions, manuell via SSH zur VM | Wenn GH-Actions down ist, oder für Debug-Sessions |

Der GH-Actions-Pfad ist Backup für Watchtower **und** der primäre Pfad
für alle Änderungen, die nicht in Image-Tags landen (Migrations,
Deploy-Scripts, Caddyfile, env-Templates).

## Voraussetzungen

### 1. SSH-Key für GitHub Actions generieren

Eigener Key, getrennt vom Operator-Key, damit Rotation/Revoke ohne
Auswirkung auf manuelle Operator-Zugänge möglich ist.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/hetzner-deploy -N "" \
  -C "github-actions@mcp-approval2"
```

### 2. Public-Key auf VM hinzufügen

```bash
ssh-copy-id -i ~/.ssh/hetzner-deploy.pub deploy@<vm_ip>
# Verify
ssh -i ~/.ssh/hetzner-deploy deploy@<vm_ip> 'echo OK'
```

### 3. GitHub-Secrets setzen

Repo-Settings → Secrets and variables → Actions → New repository secret.

| Secret | Inhalt | Beispiel |
|---|---|---|
| `HETZNER_SSH_PRIVATE_KEY` | PEM-formatted Private-Key (`cat ~/.ssh/hetzner-deploy`, inkl. `BEGIN`/`END`-Lines) | `-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----` |
| `HETZNER_VM_HOST` | VM-IP oder DNS-Name | `mcp2.ai-toolhub.org` oder `49.12.x.y` |
| `HETZNER_DOMAIN_MCP` | Public MCP-Domain | `mcp2.ai-toolhub.org` |
| `HETZNER_DOMAIN_KNOWLEDGE` | Public Knowledge-Service-Domain | `knowledge2.ai-toolhub.org` |
| `HETZNER_DOMAIN_APP` | PWA-Domain (für `environment.url` im Workflow) | `app2.ai-toolhub.org` |
| `MCP_APPROVAL_INTERNAL_TOKEN` | Bearer-Token für Smoke-Tests (= VM-`.env` Wert) | aus `/opt/mcp-approval2/.env` |
| `GHCR_TOKEN` | Read-packages PAT (nur nötig falls ghcr.io Pakete privat sind) | `ghp_…` |

Quick-Setup mit `gh` CLI:

```bash
gh secret set HETZNER_SSH_PRIVATE_KEY < ~/.ssh/hetzner-deploy
gh secret set HETZNER_VM_HOST -b "mcp2.ai-toolhub.org"
gh secret set HETZNER_DOMAIN_MCP -b "mcp2.ai-toolhub.org"
gh secret set HETZNER_DOMAIN_KNOWLEDGE -b "knowledge2.ai-toolhub.org"
gh secret set HETZNER_DOMAIN_APP -b "app2.ai-toolhub.org"
gh secret set MCP_APPROVAL_INTERNAL_TOKEN -b "$(ssh deploy@<vm_ip> 'grep INTERNAL_TOKEN /opt/mcp-approval2/.env | cut -d= -f2')"
# GHCR_TOKEN nur wenn Image privat:
gh secret set GHCR_TOKEN -b "<pat-with-read:packages>"
```

### 4. GitHub-Environment anlegen

Repo-Settings → Environments → New environment → Name: `hetzner-production`.
Optional: Required reviewers für extra-Gate vor jedem Deploy.

## Trigger-Patterns

### Manuell triggern (GitHub UI)

GitHub Actions → **Deploy to Hetzner** → Run workflow → optional Inputs setzen
(skip_migrations / target_branch).

Oder via `gh` CLI:

```bash
# Default (main, mit Migrations)
gh workflow run deploy-hetzner.yml

# Mit Optionen
gh workflow run deploy-hetzner.yml -f skip_migrations=true
gh workflow run deploy-hetzner.yml -f target_branch=hotfix/foo
```

### Auto-Deploy via Commit-Tag

Push auf `main` mit `[deploy-hetzner]` in der Commit-Subject:

```bash
git commit -m "feat: new tool [deploy-hetzner]"
git push origin main
```

Triggert den Workflow **nur** wenn:

1. `[deploy-hetzner]` im Commit-Subject UND
2. mindestens eine geänderte Datei matcht den Pfad-Filter:
   - `apps/server/**`
   - `apps/web/**`
   - `packages/**`
   - `deploy/hetzner/**`
   - `.github/workflows/deploy-hetzner.yml`

Pure-Doc-Commits ohne `[deploy-hetzner]`-Tag laufen nicht durch.

## Workflow-Phases

Was passiert während eines Deploy-Runs:

1. **Checkout latest code** — runs-on Ubuntu, holt `target_branch` (default `main`).
2. **Setup SSH agent** — lädt `HETZNER_SSH_PRIVATE_KEY` in den Agent (in-memory).
3. **Add VM to known_hosts** — `ssh-keyscan` gegen `HETZNER_VM_HOST`, vermeidet First-Connect-Prompt + MITM-Surface.
4. **Pre-deploy smoke** — SSH-Connect mit 10s-Timeout zum Verifizieren der Reachability. Failed → Workflow stoppt vor Deploy.
5. **Pre-deploy backup** — `bash backup.sh --db-only --label=pre-deploy-<sha>` auf VM. `continue-on-error: true`, weil `backup.sh` initial fehlen kann.
6. **Deploy** — SSH zur VM, `git fetch && git reset --hard origin/<branch> && bash deploy/hetzner/update.sh`. `update.sh` macht `docker compose pull && up -d && migrate`.
7. **Verify deployment** — `bash healthcheck.sh` auf VM (Container-Status, ggf. interne Health-Endpoints).
8. **Smoke test against remote** — `bash scripts/pilot-smoke-hetzner-remote.sh` von GH-Runner gegen Public-URLs (Bearer aus Secrets).
9. **Notify** — bei Erfolg nur Log-Line, bei Failure automatisches GH-Issue mit Labels `deploy-failure`, `hetzner` + Link zu Workflow-Logs.

Concurrency: `group: deploy-hetzner-${{ github.ref }}` + `cancel-in-progress: false`
sorgt dafür, dass nur ein Deploy pro Branch gleichzeitig läuft. Folgende
Runs warten, statt parallel zu deployen.

## Watchtower-Pfad

Watchtower läuft als Container im Stack (`docker-compose.yml`, parallel-Subagent
baut das gerade). Polled ghcr.io alle 5 min nach neueren Image-Tags für die
gelabelten Container und re-startet sie automatisch.

**Wann Watchtower reicht**: reine Code-Changes in Images, die ohne Migrations
oder Compose-File-Änderungen auskommen.

**Wann GH-Actions zusätzlich nötig ist**:

- DB-Migrationen
- Änderungen an `deploy/hetzner/*` (update.sh, healthcheck.sh, Caddyfile, .env.example)
- Änderungen an `docker-compose.yml` (neuer Container, neue Volumes, neue Env)
- Wenn Watchtower hängt oder Image-Pull fehlschlägt

## Troubleshooting

| Symptom | Wahrscheinliche Ursache | Lösung |
|---|---|---|
| Workflow hängt bei "Add VM to known_hosts" | `HETZNER_VM_HOST` falsch oder VM down | VM-Reachability prüfen (`ping`, manuelle SSH), Secret korrigieren |
| `Permission denied (publickey)` beim SSH | Public-Key nicht auf VM oder falscher Secret-Inhalt | `ssh-copy-id` wiederholen, `HETZNER_SSH_PRIVATE_KEY` neu setzen (cat-output) |
| Pre-deploy backup-Step failed | `backup.sh` existiert nicht / hat keinen `--db-only` Flag | OK — Step ist `continue-on-error`. Implementieren wenn Recovery-Pfad scharf gestellt wird |
| `update.sh` failed bei migrate | Schema-Drift oder ungültige Migration | Pre-deploy backup nutzen: `bash restore.sh backups/pre-deploy-<sha>` |
| `healthcheck.sh` failed | Container nicht hochgekommen, falsche Env, Caddy down | SSH zur VM, `docker compose logs --tail 100`, `docker compose ps` |
| Smoke-Test failed | Public-URL nicht erreichbar, Token falsch, App nicht ready | `docker compose logs mcp-approval2`, Caddy-Logs, DNS-Check |
| Watchtower restartet alte Version | Image-Tag nicht erneuert, Cache-Issue | `ssh deploy@vm docker compose logs watchtower`, ggf. `docker compose pull --no-cache && up -d` manuell |
| Workflow läuft nicht trotz Push | `[deploy-hetzner]`-Tag fehlt **oder** keine Datei im Pfad-Filter geändert | Tag in Commit-Subject prüfen, geänderte Pfade prüfen, `gh workflow run deploy-hetzner.yml` manuell |

Logs einsehen während Deploy:

```bash
# Workflow-Logs
gh run watch
gh run view --log-failed

# VM-Logs nach Fail
ssh deploy@<vm_ip> 'cd /opt/mcp-approval2 && docker compose logs --tail 200 -f mcp-approval2'
ssh deploy@<vm_ip> 'cd /opt/mcp-approval2 && docker compose ps'
```

## Rollback

### Option 1: Git-Revert + Re-Deploy

```bash
git revert <bad-sha>
git push origin main           # ohne [deploy-hetzner] — triggert keinen Auto-Deploy
gh workflow run deploy-hetzner.yml   # explizit deployen
```

### Option 2: SSH zur VM + manueller Rollback

```bash
ssh deploy@<vm_ip>
cd /opt/mcp-approval2
git log --oneline -10
git reset --hard <good-sha>
bash deploy/hetzner/update.sh
```

### Option 3: Restore aus Pre-Deploy-Backup

```bash
ssh deploy@<vm_ip>
cd /opt/mcp-approval2/deploy/hetzner
ls backups/pre-deploy-*
bash restore.sh backups/pre-deploy-<sha>
```

Siehe auch [runbook-hetzner-backup-restore.md](runbook-hetzner-backup-restore.md)
für die volle Restore-Mechanik.

## Was zu vermeiden

- **KEINE Real-Production-Secrets im Workflow-File** committen — alles via `${{ secrets.* }}`.
- **`deploy/hetzner/`** und **`scripts/`** nicht aus dem Workflow heraus modifizieren — der Workflow konsumiert die Files, der Build-Pfad bleibt separat.
- **Existing Workflows** (`deploy.yml`, `ci.yml`, `smoke-hetzner.yml`, `build-container.yml`, `terraform-plan.yml`) **nicht anfassen** — orthogonale Pfade.
- **`StrictHostKeyChecking=no`** im SSH-Call vermeiden — `known_hosts` über `ssh-keyscan` ist sicherer (MITM-Schutz).
- **Concurrent-Deploys** vermeiden — `concurrency.cancel-in-progress: false` reiht Runs ein statt sie zu killen. Nicht überschreiben.
- **`--force-recreate`** in `update.sh` nicht hineinwartet, ohne dass es nötig ist — unnötige Downtime.

## Secret-Rotation

Cadence: alle 90 Tage oder bei Personalwechsel.

```bash
# 1. Neuen Key erzeugen
ssh-keygen -t ed25519 -f ~/.ssh/hetzner-deploy-new -N "" -C "github-actions@mcp-approval2"

# 2. Auf VM hinzufügen (alt + neu parallel)
ssh-copy-id -i ~/.ssh/hetzner-deploy-new.pub deploy@<vm_ip>

# 3. GitHub-Secret überschreiben
gh secret set HETZNER_SSH_PRIVATE_KEY < ~/.ssh/hetzner-deploy-new

# 4. Workflow manuell triggern, Erfolg verifizieren
gh workflow run deploy-hetzner.yml
gh run watch

# 5. Alten Key von VM entfernen
ssh deploy@<vm_ip> 'sed -i "/github-actions@mcp-approval2.*<old-fingerprint>/d" ~/.ssh/authorized_keys'

# 6. Lokal alten Key löschen
rm ~/.ssh/hetzner-deploy ~/.ssh/hetzner-deploy.pub
mv ~/.ssh/hetzner-deploy-new ~/.ssh/hetzner-deploy
mv ~/.ssh/hetzner-deploy-new.pub ~/.ssh/hetzner-deploy.pub
```

## Acceptance-Checklist (für initialen Setup)

- [ ] SSH-Key erzeugt, Public-Key auf VM, `ssh -i ~/.ssh/hetzner-deploy deploy@<vm_ip> 'echo OK'` funktioniert
- [ ] Alle 7 GH-Secrets gesetzt (`gh secret list`)
- [ ] GH-Environment `hetzner-production` angelegt
- [ ] `gh workflow run deploy-hetzner.yml` läuft grün
- [ ] Pre-deploy backup-Step läuft (auch `continue-on-error` ist akzeptabel)
- [ ] Healthcheck + Smoke-Test grün
- [ ] Test-Failure (z.B. via fehlerhafte Migration im Test-Branch) erzeugt GH-Issue mit Labels `deploy-failure`, `hetzner`
- [ ] Rollback-Pfad einmal manuell durchgespielt
