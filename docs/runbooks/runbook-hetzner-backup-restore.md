# Runbook: Hetzner Backup + Restore

> **Status:** Ready
> **Letzte Verifikation:** 2026-05-13
> **Estimated time:** 5-10 min (Manual Backup) / 20-40 min (Restore)

Backup-Strategie fuer mcp-approval2 auf Hetzner. Drei Schichten:

1. **Hetzner Snapshots** — VM-weit, taeglich automatisch
2. **DB-Dump + Vault-Snapshot** — application-level, nach systemd-timer
3. **Manual Backup** — vor riskanten Updates (Rotation, Migration)

## Voraussetzungen

- **Storage Box** (optional, empfohlen) — Hetzner Storage Box 1 TB (~4 €/Mo)
  - alternativ: Lokaler Disk-Space ≥ 30 GB free
- **Backup-Encryption-Key** generiert + offline gesichert
  - `openssl rand -base64 32 > /opt/mcp-approval2/.backup-key`
  - Key sofort auf Paper + USB sichern, dann shreddable Kopie auf VM behalten
- SSH zur VM als `deploy`-User
- `borgbackup` oder `restic` installiert (optional, fuer Storage-Box-Push)

## Schritte

### 1. Automated Daily Backup (systemd-timer)

Wird beim Initial-Deploy via cloud-init eingerichtet. Verifikation:

```bash
ssh deploy@${VM_IP}
systemctl list-timers | grep mcp-approval2

# Expect:
# mcp-approval2-backup.timer  daily 03:00 UTC
```

Was der Timer macht (Skript `deploy/hetzner/backup.sh`):

1. **Postgres-Dump** (alle DBs):
   ```bash
   docker compose exec -T postgres pg_dumpall -U app \
     | gzip -9 \
     | openssl enc -aes-256-cbc -salt -pass file:/opt/mcp-approval2/.backup-key \
     > /var/backups/mcp-approval2/db-$(date +%Y%m%d-%H%M).sql.gz.enc
   ```
2. **Vault-Snapshot** (raft snapshot oder file-backup):
   ```bash
   docker compose exec -T openbao bao operator raft snapshot save - \
     | openssl enc -aes-256-cbc -salt -pass file:/opt/mcp-approval2/.backup-key \
     > /var/backups/mcp-approval2/vault-$(date +%Y%m%d-%H%M).snap.enc
   ```
3. **Blob-Storage** (falls vorhanden, local-fs tar):
   ```bash
   tar -C /opt/mcp-approval2/data/blob -cf - . \
     | gzip -9 \
     | openssl enc -aes-256-cbc -salt -pass file:/opt/mcp-approval2/.backup-key \
     > /var/backups/mcp-approval2/blob-$(date +%Y%m%d-%H%M).tar.gz.enc
   ```
4. **Push to Storage Box** (wenn konfiguriert):
   ```bash
   rsync -av /var/backups/mcp-approval2/ \
     u123456@u123456.your-storagebox.de:./mcp-approval2-privat/
   ```
5. **Retention-Cleanup:**
   - Daily backups: 7d
   - Weekly (Sonntag): 4w
   - Monthly (1. des Monats): 12 Monate

Erwartetes Output:
```
[2026-05-13 03:00:01] Starting backup
[2026-05-13 03:00:12] DB dump: 142 MB encrypted
[2026-05-13 03:00:18] Vault snapshot: 8 MB encrypted
[2026-05-13 03:00:24] Blob: 28 MB encrypted
[2026-05-13 03:00:35] Pushed to storage box
[2026-05-13 03:00:36] Retention: deleted 1 file (>7d)
[2026-05-13 03:00:36] Backup OK
```

### 2. Manual Backup (vor riskanten Updates)

```bash
ssh deploy@${VM_IP}
cd /opt/mcp-approval2
bash deploy/hetzner/backup.sh --tag manual-pre-rotation
```

Erwartetes Output: Files in `/var/backups/mcp-approval2/` mit `-manual-pre-rotation`-Suffix.

```bash
ls -lh /var/backups/mcp-approval2/ | grep manual
# Expect: 3 Files (db, vault, blob) mit timestamp
```

### 3. Restore-Verfahren

**WICHTIG:** Restore **immer auf einer Test-VM zuerst** durchspielen. Niemals
direkt auf Prod-VM ohne Verifikation.

#### 3.1 DB-Restore

```bash
ssh deploy@${VM_IP}
cd /opt/mcp-approval2

# Backup-File auswaehlen
BACKUP_FILE=/var/backups/mcp-approval2/db-20260513-0300.sql.gz.enc

# Decrypt + Decompress + Inspect
openssl enc -aes-256-cbc -d -pass file:/opt/mcp-approval2/.backup-key \
  -in "$BACKUP_FILE" | gunzip | head -50
# Expect: "-- PostgreSQL database cluster dump"

# Bei Restore in laufende Prod-DB: erst Services stoppen
docker compose stop mcp-approval2 mcp-knowledge2

# DB droppen + recreaten
docker compose exec -T postgres psql -U app -c "DROP DATABASE IF EXISTS approval2;"
docker compose exec -T postgres psql -U app -c "DROP DATABASE IF EXISTS knowledge2;"

# Restore
openssl enc -aes-256-cbc -d -pass file:/opt/mcp-approval2/.backup-key \
  -in "$BACKUP_FILE" \
  | gunzip \
  | docker compose exec -T postgres psql -U app

# Services restarten
docker compose up -d mcp-approval2 mcp-knowledge2

# Smoke
bash deploy/hetzner/healthcheck.sh
```

Erwartetes Output: `healthcheck.sh` zeigt alle Services OK, beide DBs lesbar.

#### 3.2 Vault-Restore

```bash
BACKUP_FILE=/var/backups/mcp-approval2/vault-20260513-0300.snap.enc

# Decrypt
openssl enc -aes-256-cbc -d -pass file:/opt/mcp-approval2/.backup-key \
  -in "$BACKUP_FILE" \
  > /tmp/vault-restore.snap

# Vault unsealed haben
docker compose exec openbao bao status
# Expect: Sealed: false

# Restore (force, weil ueber bestehende Daten)
read -rs VAULT_ROOT_TOKEN
docker compose exec -T -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" openbao \
  bao operator raft snapshot restore -force - < /tmp/vault-restore.snap

# Verify
docker compose exec -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" openbao \
  bao list transit/keys
# Expect: mcp-approval2-kek, mcp-knowledge2-kek

shred -u /tmp/vault-restore.snap
unset VAULT_ROOT_TOKEN
```

#### 3.3 Verify-Backup-Skript

```bash
bash deploy/hetzner/verify-backup.sh /var/backups/mcp-approval2/db-20260513-0300.sql.gz.enc
```

Was verify-backup.sh macht:
1. Decrypt + Decompress in temp-dir
2. Pruefen ob valider Postgres-Dump (Header-Check)
3. Spawnt temp Postgres-Container, restored den Dump
4. Pruefen ob Tabellen-Count > 0
5. Cleanup temp-container

Erwartetes Output:
```
[OK] decrypt successful
[OK] gzip integrity OK
[OK] postgres dump header valid
[OK] restore to temp-db successful
[OK] tables found: 42 (approval2) + 18 (knowledge2)
[OK] backup is restore-able
```

## Troubleshooting

- **Problem:** `openssl enc -d` liefert `bad decrypt`
  → **Loesung:** Backup-Key falsch. Pruefen ob `.backup-key` File-Inhalt
    identisch zum Original (`sha256sum`).

- **Problem:** Backup-Skript schlaegt mit `disk full`
  → **Loesung:** `df -h /var/backups`. Retention-Skript laufen lassen oder
    Storage Box als Push-Target verwenden.

- **Problem:** Vault-Restore liefert `mismatch in raft cluster id`
  → **Loesung:** `-force` Flag noetig. Aber: pruefen ob es wirklich derselbe
    Cluster ist — bei VM-Wechsel muss erst neuer Vault init-ed werden.

- **Problem:** DB-Restore wirft `database "approval2" is being accessed by other users`
  → **Loesung:** mcp-approval2 + mcp-knowledge2 Container stoppen vor Restore.
    Cron-Jobs (backup-timer) pausieren via `systemctl stop mcp-approval2-backup.timer`.

- **Problem:** Storage Box `rsync` schlaegt mit `Permission denied`
  → **Loesung:** SSH-Key auf Storage Box pruefen.
    `ssh-copy-id u123456@u123456.your-storagebox.de` oder Web-UI nutzen.

- **Problem:** Verify-Backup zeigt `tables found: 0`
  → **Loesung:** Dump ist incomplete (z.B. wegen DB-Lock). Pre-Dump-Hook
    in backup.sh pruefen — sollte `pg_isready` warten.

## Verifikation

Daily-Backup laeuft korrekt:

- [ ] `systemctl status mcp-approval2-backup.timer` aktiv
- [ ] `ls /var/backups/mcp-approval2/ | wc -l` zeigt min. 7 Files
- [ ] Letztes Backup juenger als 25 h
- [ ] `bash deploy/hetzner/verify-backup.sh <latest-db>` OK
- [ ] Storage Box hat juengsten Backup (wenn konfiguriert)
- [ ] Backup-Encryption-Key noch offline gesichert verfuegbar

Restore-Drill (1× pro Quartal):

- [ ] Test-VM hochfahren, Backup einspielen, `/health` 200, bekannte DB-Row lesbar
- [ ] Drill-Log mit Zeitstempel + Recovery-Time in `docs/drills/`

## Referenzen

- [PLAN-hetzner-deployment §7 Backup](../plans/active/PLAN-hetzner-deployment.md#backup)
- [runbook-hetzner-disaster-recovery.md](runbook-hetzner-disaster-recovery.md)
- [runbook-hetzner-rotate-vault.md](runbook-hetzner-rotate-vault.md)
