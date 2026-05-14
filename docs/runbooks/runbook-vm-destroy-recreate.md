# Runbook: VM destroy + re-provision (Sparmodus)

> **Status:** Ready (2026-05-14, validated against Pilot-Erst-Deploy)
> **Estimated time:** 15-22 min Wall-Time (5-8 min davon Image-Build)
> **Trigger:** Pause > 1 Monat ohne User-Daten, oder VM-Konfig-Reset noetig

Wenn die Hetzner-VM laenger nicht gebraucht wird, kann sie komplett
geloescht werden statt powered-off zu liegen. Das spart ~4.50 EUR/Monat
(Disk-Reservierung bei `status=off`) und garantiert einen sauberen
Re-Setup beim naechsten Start.

## ⚠ Wichtige Hinweise vor dem Loslaufen

### 1. Daten-Verlust ist garantiert
Diese sieben Stores sind nach `destroy` weg:

| Was | Folge |
|---|---|
| Hetzner-VM + Root-Disk (80 GB) | komplette VM weg, neue IP nach apply |
| `hetzner_pgdata` (Postgres) | alle DB-Daten, User-Tabelle, Apps, Objects weg |
| `hetzner_vault-data` (OpenBao) | DEKs + Transit-Keys weg → Encrypted-Credentials nicht mehr entschluesselbar |
| `hetzner_caddy-data` (Let's Encrypt Certs) | Certs werden neu via ACME geholt (1-3 min, kostenlos) |
| `hetzner_caddy-config` (auto config) | Caddy regeneriert beim Boot |
| `.vault-init-output.json` (VM-side, chmod 600) | Unseal-Keys weg → muss neu init + offline backup |
| Cloudflare-DNS-Records | werden re-applied (gleiche Domains, neue IP) — kein User-Eingriff noetig |

**NICHT verloren:**
- Doppler-Secrets (32/35 in Doppler, separate Backend-Storage)
- GitHub-Repo + Branch-Protection (terraform-managed, idempotent)
- Terraform-State (R2-Backend)
- Code (Git-Repo)

### 2. Vault-Init-Output muss offline gesichert werden
Das Script erstellt **NEUE** Unseal-Keys + Root-Token jedes Mal. Es legt
sie unter `.vault-init-backups/vault-init-<ts>.{log,json}` lokal ab
(chmod 600, gitignored). **Vor der naechsten destroy-recreate-Runde:**
- Backups offline sichern (Paper-Wallet ODER verschluesselter USB)
- Doppler `VAULT_TOKEN` wird automatisch upgedated, alter Token wird
  unbrauchbar weil neue Vault-Instance

### 3. Let's-Encrypt-Rate-Limit
Cert-Issuance ist auf **5 Cert-Renewals pro Domain pro Woche** limitiert
(Lets-Encrypt-Public-Limit). Destroy-recreate produziert pro Run 3 neue
Certs (mcp2 + app2 + coop-bypass-FQDN). Theoretisches Limit:
~1 destroy-recreate pro 1-2 Tage ueber 1 Woche bevor Rate-Limit greift.
In der Praxis irrelevant — wir machen das vielleicht 2-3x pro Monat.

### 4. Pre-Phase-2-Bedingung
Solange noch keine User-Daten in der DB sind (Phase 1, keine echten
Passkeys/Apps enrolled), ist destroy-recreate verlustfrei. Sobald
das System produktiv genutzt wird:
- **Backup-First-Pflicht:** `ssh mcp-approval2-vm 'sudo bash /opt/mcp-approval2/deploy/hetzner/backup.sh now'`
- Backup landet auf R2 (Cron-Job laeuft monatlich automatisch)
- Vor destroy: backup-File-Listing in der R2-UI verifizieren

### 5. SSH-Config aktualisieren wenn IP wechselt
Hetzner re-vergibt **meist** die gleiche IP innerhalb von ~5 min, aber
nicht garantiert. Das Script updated `~/.ssh/config` automatisch wenn
die neue IP abweicht. Andere Tools die die alte IP cachen
(`known_hosts`, Bash-History-Werte) muss der Operator selbst aufraeumen.

### 6. Script ist resumable
Bei Abbruch mitten im Script:
- Stage 1-5 (destroy + apply): re-run mit `--yes` (idempotent — terraform
  erkennt vorhandene Ressourcen)
- Stage 6-17 (Konfig + Boot): re-run mit `--resume` (ueberspringt
  destroy+apply, geht direkt zu docker-compose-plugin, Image-Build, etc.)

## Ablauf in 17 Schritten

| # | Schritt | Dauer | Skript-Stage |
|---|---|---|---|
| 1 | `prevent_destroy = true` auskommentieren | 5s | sed-Edit |
| 2 | `terraform destroy` | 2 min | wrapper |
| 3 | `prevent_destroy` wieder einkommentieren | 5s | sed-Edit |
| 4 | `terraform apply` | 2-3 min | wrapper |
| 5 | warten bis VM SSH-reachable | 10-30s | poll-loop |
| 6 | docker-compose-plugin via official Docker apt repo | 1 min | ssh |
| 7 | doppler-cli installieren | 30s | ssh |
| 8 | Doppler-VM-Token deployen (chmod 600) | 10s | tf-output |
| 9 | doppler-vm-sync.sh → rendert .env | 20s | ssh |
| 10 | render-config.sh → rendert Caddyfile | 10s | ssh |
| 11 | **mcp-approval2 Image lokal bauen** (GHCR private) | 5-8 min | ssh docker build |
| 12 | `docker compose up -d postgres openbao` | 30s | ssh compose |
| 13 | `vault-init.sh` — NEUE Unseal-Keys + Root-Token | 1 min | ssh + local backup |
| 14 | `VAULT_TOKEN` in Doppler stempeln | 5s | doppler set |
| 15 | doppler-vm-sync.sh re-sync (mit VAULT_TOKEN) | 20s | ssh |
| 16 | docker compose up -d (alle) + `npx tsx scripts/migrate.ts` | 1-2 min | ssh compose |
| 17 | Smoke (wartet auf Lets-Encrypt-Cert) | 1-3 min | curl-poll |

**Gesamt: 15-22 min wall-time.** Image-Build ist der dickste Block —
wenn wir je auf einen GHCR-Token mit `read:packages` umsteigen, faellt
das auf <30s.

## Ausfuehrung

### Voraussetzungen (Lokales devcontainer-Setup)

- `.dev.vars` enthaelt `DOPPLER_TOKEN=dp.pt.…` (Personal-Token, workplace:admin)
- `terraform`, `doppler`, `jq`, `ssh` im PATH
- SSH-Key `~/.ssh/mcp-approval2-operator` vorhanden (siehe
  [runbook-hetzner-deploy.md](runbook-hetzner-deploy.md) Step 4 fuer
  Erst-Generation)
- `~/.ssh/config` mit `Host mcp-approval2-vm` (Script kann nachpatchen
  bei IP-Wechsel, aber initialer Eintrag muss vom Operator gesetzt sein)

### Interaktiver Run (default — Konfirmation per Hand)

```bash
cd /workspaces/mcp-approval2
bash scripts/vm-destroy-recreate.sh
```

Script fragt einmal `Sicher? Tippe 'DESTROY' zum Fortfahren:`. Nur
`DESTROY` (exakt) bestaetigt — alles andere bricht ab.

### Non-interaktiv (z.B. aus einem anderen Script)

```bash
bash scripts/vm-destroy-recreate.sh --yes
```

Kein Prompt. **NICHT in automation runs ohne human-supervisor** — das
ist eine destruktive Operation.

### Resume nach Abbruch (Stage 6+)

Wenn der Run irgendwo zwischen Step 6 und 17 stirbt (z.B. SSH-Timeout
beim Image-Build):

```bash
bash scripts/vm-destroy-recreate.sh --resume
```

Skipped destroy+apply, faengt bei Step 6 (docker-compose-plugin)
neu an. Idempotent — Steps die schon erledigt sind, werden uebersprungen.

## Smoke-Test danach

Script macht das automatisch in Step 17. Manuell:

```bash
curl -sI https://mcp2.ai-toolhub.org/health    # API
curl -sI https://app2.ai-toolhub.org/          # PWA
curl -sI https://static.<reversed-ip>.clients.your-server.de/health
```

Erwartet: 3x `HTTP/2 200`. Wenn `503 no upstreams available` → Container
noch nicht healthy, ~30s warten.

## Logs + Backups

| Pfad | Inhalt | Aufraeumen |
|---|---|---|
| `.vm-destroy-recreate.log` | append-only Log aller Runs | gitignored, manuell rotieren wenn > 10 MB |
| `.vault-init-backups/vault-init-<ts>.json` | NEUE Vault-Init-Outputs (chmod 600) | gitignored. **Offline backupen, dann loeschen!** Pro Run ein File. |
| `.vault-init-backups/vault-init-<ts>.log` | dito Plain-Text-Log | dito |

`gitignored` heisst: nicht im Repo, lokal. Nicht in eine
Cloud-Sync-Ordner (Dropbox/iCloud) ablegen — sensitive Material.

## Vergleichs-Tabelle: andere Power-Stati

| Variante | Kosten | Restart | Daten-Verlust |
|---|---|---|---|
| **Stack down, VM running** | 30 ct/Tag | 30s | keiner |
| **VM powered off** | 15 ct/Tag | 5 min | keiner |
| **VM destroyed (dieser Runbook)** | 0 ct/Tag | 15-22 min | DB + Vault + Certs |
| **VM deleted + Doppler-Reset** | 0 ct/Tag | 30+ min | alles + Secrets |

Default fuer aktive Entwicklung: **Stack-Down + VM-running**.
Default fuer mehrwoechige Pausen: **VM powered off**.
Default fuer Architecture-Reset oder Onboarding-Demo: **destroy + recreate**.

## Referenzen

- [runbook-vm-start-stop.md](runbook-vm-start-stop.md) — Power-Management ohne destroy
- [runbook-hetzner-deploy.md](runbook-hetzner-deploy.md) — Initial-Deploy (was das Skript automatisiert)
- [runbook-doppler.md](runbook-doppler.md) — Secret-Management
- [runbook-hetzner-backup-restore.md](runbook-hetzner-backup-restore.md) — Backup-Schritte vor destroy
- Script: [scripts/vm-destroy-recreate.sh](../../scripts/vm-destroy-recreate.sh)
