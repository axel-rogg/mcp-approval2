# Runbook: Hetzner Disaster Recovery

> **Status:** Ready
> **Letzte Verifikation:** 2026-05-13
> **Estimated time:** 30 min (VM-Loss mit Snapshot) / 2-4 h (Komplett-Wiederaufbau)

Komplett-Wiederherstellung des mcp-approval2-Stacks nach Disaster.
Vier Recovery-Szenarien mit unterschiedlichen RTO/RPO-Targets.

## RTO/RPO Targets

| Szenario | RTO (Recovery Time) | RPO (Recovery Point) |
|---|---|---|
| VM-Loss (Snapshot vorhanden) | 30 min | ≤ 24 h |
| DB-Corruption | 45 min | ≤ 24 h |
| Vault-Loss (Backup vorhanden) | 60 min | ≤ 24 h |
| Komplett-Wiederaufbau (Zero) | 4 h | User re-OAuth + neue Passkeys |

## Voraussetzungen

- Cloudflare-API-Token zum DNS-Switch
- Hetzner-API-Token + funktionierende Terraform-Workspace
- **Offline-Backup verfuegbar:**
  - Vault Unseal-Keys (2 von 3, Threshold)
  - Vault Root-Token (optional, für Break-Glass)
  - Backup-Encryption-Key
  - Vault-Snapshot juenger als RPO
  - DB-Dump juenger als RPO
- SSH-Key des Operators
- Repo-Zugriff `mcp-approval2`

## Schritte

### 1. VM-Loss Recovery (neue VM via Terraform)

**Szenario:** VM ist weg (Hetzner-Outage, accidental delete, hardware-failure).
Daten-Volume + Snapshot existieren noch.

```bash
# Lokal
cd /workspaces/mcp-approval2/terraform/environments/privat

# State pruefen
terraform state list | grep hcloud_server

# Server-Resource taintet markieren
terraform taint module.privat.hcloud_server.mcp

# Apply triggert recreate
terraform plan      # Expect: 1 to add, 1 to destroy
terraform apply
```

Falls Hetzner-Snapshot existiert (taeglich via Auto-Snapshot):

```bash
# Snapshot auswaehlen
hcloud image list --type snapshot --selector "instance=mcp-approval2-privat"

# Terraform-Var setzen
echo 'restore_from_snapshot_id = "12345678"' >> terraform.tfvars
terraform apply
```

DNS bleibt unveraendert (zeigt auf alte VM-IP). Falls IP wechselt:

```bash
# Terraform updated A-Records automatisch wenn vm_ipv4 sich aendert
terraform apply
# CF-DNS propagiert in 1-5 min (TTL=1, auto)
```

Volume + DB-Snapshot wieder anhaengen:

```bash
ssh deploy@${NEW_VM_IP}
cd /opt/mcp-approval2

# Falls Volume separat existierte: schon via Terraform-Reattach an neuer VM
# Falls nur Snapshot: Daten sind im VM-Image

bash deploy/hetzner/healthcheck.sh
```

Erwartetes Output: alle Services OK in 30 min, Daten bis RPO ≤ 24 h.

### 2. DB-Corruption (pg_restore)

**Szenario:** Postgres ist korrupt, aber VM + Vault sind intakt.

```bash
ssh deploy@${VM_IP}
cd /opt/mcp-approval2

# Services stoppen (Vault stays up wegen Re-Wrap-Risiko)
docker compose stop mcp-approval2 mcp-knowledge2

# Letztes valides Backup waehlen
ls -lh /var/backups/mcp-approval2/db-*.sql.gz.enc | tail -5
BACKUP_FILE=/var/backups/mcp-approval2/db-20260513-0300.sql.gz.enc

# Pre-Restore: Verify Backup
bash deploy/hetzner/verify-backup.sh "$BACKUP_FILE"

# DB neu aufsetzen
docker compose exec -T postgres psql -U app -c "DROP DATABASE IF EXISTS approval2;"
docker compose exec -T postgres psql -U app -c "DROP DATABASE IF EXISTS knowledge2;"
docker compose exec -T postgres psql -U app -c "CREATE DATABASE approval2;"
docker compose exec -T postgres psql -U app -c "CREATE DATABASE knowledge2;"

# Restore
openssl enc -aes-256-cbc -d -pass file:/opt/mcp-approval2/.backup-key \
  -in "$BACKUP_FILE" \
  | gunzip \
  | docker compose exec -T postgres psql -U app

# Service-Restart
docker compose up -d

# Verifikation
bash deploy/hetzner/healthcheck.sh
docker compose exec postgres psql -U app -d approval2 -c "SELECT COUNT(*) FROM users;"
```

Erwartetes Output: User-Count > 0, alle Services OK.

### 3. Vault-Loss (aus unseal-keys + transit-key-snapshot)

**Szenario:** vault-data Docker-Volume ist weg, aber DB + Backups vorhanden.

```bash
ssh deploy@${VM_IP}
cd /opt/mcp-approval2

# Services stoppen
docker compose stop mcp-approval2 mcp-knowledge2 openbao

# Volume entfernen
docker volume rm $(docker compose ps -q openbao | xargs docker inspect -f '{{ range .Mounts }}{{ .Name }}{{ end }}' | grep vault)

# Vault frisch starten
docker compose up -d openbao
docker compose exec openbao bao status
# Expect: Sealed: true, Initialized: false

# Letzten Vault-Snapshot laden
ls -lh /var/backups/mcp-approval2/vault-*.snap.enc | tail -3
BACKUP_FILE=/var/backups/mcp-approval2/vault-20260513-0300.snap.enc

openssl enc -aes-256-cbc -d -pass file:/opt/mcp-approval2/.backup-key \
  -in "$BACKUP_FILE" \
  > /tmp/vault-restore.snap

# Vault initialisieren (fresh), dann snapshot restore
docker compose exec openbao bao operator init -key-shares=3 -key-threshold=2 \
  > /tmp/new-init.txt
# WICHTIG: temporaere Init-Keys + Root, weil restore-snapshot diese
# durch die alten Werte ueberschreibt
TEMP_ROOT=$(grep "Initial Root Token" /tmp/new-init.txt | awk '{print $NF}')
TEMP_K1=$(grep "Unseal Key 1" /tmp/new-init.txt | awk '{print $NF}')
TEMP_K2=$(grep "Unseal Key 2" /tmp/new-init.txt | awk '{print $NF}')

docker compose exec openbao bao operator unseal "$TEMP_K1"
docker compose exec openbao bao operator unseal "$TEMP_K2"

docker compose exec -T -e VAULT_TOKEN="$TEMP_ROOT" openbao \
  bao operator raft snapshot restore -force - < /tmp/vault-restore.snap

# Nach Restore: alte Unseal-Keys gelten wieder
# Vault muss re-unsealed werden mit den ALTEN Keys (aus offline-backup)
read -rs OLD_KEY_1
read -rs OLD_KEY_2

docker compose exec openbao bao operator unseal "$OLD_KEY_1"
docker compose exec openbao bao operator unseal "$OLD_KEY_2"

# Cleanup
shred -u /tmp/vault-restore.snap /tmp/new-init.txt
unset TEMP_ROOT TEMP_K1 TEMP_K2 OLD_KEY_1 OLD_KEY_2

# Services hoch
docker compose up -d
bash deploy/hetzner/healthcheck.sh
```

Erwartetes Output: alle DEK-encrypted Daten wieder lesbar, Services OK.

### 4. Komplett-Wiederaufbau (Zero — Vault-Loss + Backup-Loss)

**Szenario:** Worst-Case: VM weg + Backups weg + Vault-Keys weg.
**Konsequenz:** alle DEK-encrypted Daten unbrauchbar (OAuth-Tokens, gateway-Credentials,
Passkey-Bindings teilweise). User muessen re-OAuth-en + neue Passkeys enrollen.

```bash
# 1. Lokal: neuen Terraform-Stack aufsetzen
cd /workspaces/mcp-approval2/terraform/environments/privat

# Falls State weg ist: aus R2 ziehen oder neu init
terraform init -reconfigure
terraform apply
```

```bash
# 2. SSH zur neuen VM
ssh deploy@${NEW_VM_IP}
cd /opt
sudo git clone https://github.com/axel-rogg/mcp-approval2.git
sudo chown -R deploy:deploy mcp-approval2
cd mcp-approval2

# 3. Frische Secrets generieren
bash deploy/hetzner/generate-secrets.sh > .env
chmod 600 .env
# Manuell: GOOGLE_OAUTH_CLIENT_ID, VERTEX_AI_PROJECT_ID, Domains

# 4. Fresh-Initial-Setup
bash deploy/hetzner/setup.sh
# Vault init produziert NEUE Unseal-Keys + Root-Token
# NEUES Offline-Backup SOFORT machen!

# 5. DB-Migrations (frisch)
docker compose exec mcp-approval2 node scripts/migrate.js
docker compose exec mcp-knowledge2 node scripts/migrate.js

# 6. Backup-Encryption-Key NEU generieren
openssl rand -base64 32 > /opt/mcp-approval2/.backup-key
# offline backupen!

# 7. Smoke
bash deploy/hetzner/healthcheck.sh
```

User-Side:
```
- Alle User muessen sich neu via Google-OAuth einloggen
- Neue Passkeys enrollen (alte WebAuthn-Credentials sind gone)
- Sub-MCP-OAuth-Connections re-bestaetigen
- Apps-State ist weg (lokale Daten in PWA-IndexedDB ueberleben falls Browser nicht gewipt)
```

Erwartetes Output: 4 h Recovery-Time, alle User mit fresh-Setup.

## Troubleshooting

- **Problem:** Terraform-State korrupt (R2-Backend nicht erreichbar)
  → **Loesung:** `terraform init -reconfigure -backend-config="..."`. Falls
    State weg: aus `terraform.tfstate.backup` ziehen oder `terraform import`
    fuer existierende Resources.

- **Problem:** Hetzner-Snapshot von vor 3 Wochen, Daten zu alt
  → **Loesung:** DB-Restore aus juengstem `db-*.sql.gz.enc` ueber den
    Snapshot-Stand. Daten between Snapshot + DB-Dump sind verloren (~24 h Lag).

- **Problem:** Vault-Snapshot-Restore liefert `cluster id mismatch`
  → **Loesung:** Vault muss frisch init-ed sein (clean volume) bevor snapshot
    restore-force funktioniert. Volume neu erstellen.

- **Problem:** Komplett-Wiederaufbau: User-OAuth schlaegt fehl
  → **Loesung:** Google-OAuth-Client redirect_uri muss neue Domain enthalten
    (`https://app2.ai-toolhub.org/oauth/callback`). GCP Console → APIs → OAuth.

- **Problem:** DNS propagiert nicht nach VM-IP-Wechsel
  → **Loesung:** CF-Cache purge via Terraform-Output checken + `dig +trace`.
    Notfall-Override: TTL temporaer auf 60s setzen.

## Verifikation

Post-Recovery-Checks:

- [ ] `bash deploy/hetzner/healthcheck.sh` zeigt alle Services OK
- [ ] HTTPS-Endpoints liefern 200 mit valid SSL
- [ ] First-Admin-Login via OAuth funktioniert (Test-User)
- [ ] DB-Row-Count plausibel (z.B. users > 0, audit_log > 0)
- [ ] Vault `bao read transit/keys/mcp-approval2-kek` zeigt erwartete Version
- [ ] Random-Credential entschluesselbar (z.B. User-OAuth-Token via App)
- [ ] Backup-Timer wieder aktiv: `systemctl status mcp-approval2-backup.timer`
- [ ] Nach Recovery: erstes Backup explizit triggern `bash deploy/hetzner/backup.sh --tag post-dr`
- [ ] Drill-Log mit Recovery-Time in `docs/drills/` eingetragen

## Drill-Schedule

| Drill | Cadence | Owner |
|---|---|---|
| DB-Restore (Test-VM) | Quartalsweise | Operator |
| Vault-Restore (Test-VM) | Quartalsweise | Operator |
| Komplett-Wiederaufbau (Test-VM) | Jaehrlich | Operator |

## Referenzen

- [PLAN-hetzner-deployment §7 Disaster Recovery](../plans/active/PLAN-hetzner-deployment.md#disaster-recovery)
- [runbook-hetzner-backup-restore.md](runbook-hetzner-backup-restore.md)
- [runbook-hetzner-deploy.md](runbook-hetzner-deploy.md)
- [runbook-incident-response.md](runbook-incident-response.md)
