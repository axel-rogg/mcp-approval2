# Runbook: Hetzner Backup + Restore

> **Status:** Ready
> **Letzte Verifikation:** 2026-05-16 (Script-Drift behoben)
> **Estimated time:** 5-10 min (Manual Backup) / 20-40 min (Restore)

Backup-Strategie für mcp-approval2 + mcp-knowledge2 auf Hetzner. Drei
Schichten:

1. **Hetzner Snapshots** — VM-weit, taeglich automatisch (in Hetzner Cloud Console)
2. **DB-Dump + Vault-Snapshot** — application-level, via systemd-timer
   (`mcp-backup.timer`, installiert durch `setup.sh`)
3. **Manual Backup** — vor riskanten Updates (Rotation, Migration, Cutover)

Encryption: alle application-level Backups (Layer 2 + 3) werden mit
AES-256-CBC + PBKDF2 (100k Iterationen, random Salt) verschluesselt.
Der Key liegt in `/opt/mcp-approval2/.backup-key` (mode 600, deploy-owned).

## Voraussetzungen

- **Storage Box** (optional, empfohlen) — Hetzner Storage Box 1 TB (~4 €/Mo).
  Konfiguration: `STORAGE_BOX_USER`, `STORAGE_BOX_HOST` als env-vars in
  `/etc/default/mcp-backup` ODER in `.env`.
- **Backup-Encryption-Key**, einmalig erzeugt + offline gesichert:
  ```bash
  sudo install -o deploy -g deploy -m 600 /dev/null /opt/mcp-approval2/.backup-key
  openssl rand -base64 48 > /opt/mcp-approval2/.backup-key
  cat /opt/mcp-approval2/.backup-key   # SOFORT auf Paper / USB / Doppler-Vault
  ```
  Ohne den Key sind verschluesselte Backups irrecoverable. Die On-VM-Kopie
  ist nur fuer den Backup-Cron — die offline-Kopie ist das eigentliche
  Recovery-Mittel bei VM-Totalverlust.
- SSH zur VM als `deploy`-User
- `setup.sh` muss einmal gelaufen sein (installiert den systemd-Timer)

## Schritte

### 1. Automated Daily Backup (systemd-timer)

Wird beim Initial-Deploy via `setup.sh` eingerichtet
(`/etc/systemd/system/mcp-backup.{service,timer}` aus
`deploy/hetzner/systemd/`). Verifikation:

```bash
ssh deploy@${VM_IP}
systemctl list-timers mcp-backup.timer
# Expect:
#   NEXT                LAST   PASSED  UNIT              ACTIVATES
#   Sat 2026-05-17 03:00 UTC ... mcp-backup.timer  mcp-backup.service
```

Was der Timer macht (Skript `deploy/hetzner/backup.sh`):

1. **Postgres-Dumps** (eine Datei pro logische DB):
   ```bash
   docker compose exec -T postgres pg_dump -U app -d approval2  --no-owner --clean --if-exists \
     | gzip -9 \
     | openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt -pass file:/opt/mcp-approval2/.backup-key \
     > /var/backups/mcp-approval2/<DATE>/approval2.sql.gz.enc
   ```
   Dasselbe nochmal fuer `knowledge2`.
2. **Vault-Snapshot** — File-Backend tar (OpenBao laeuft mit
   `storage "file"`; **kein** `bao operator raft snapshot`):
   ```bash
   docker run --rm -v $(docker volume inspect -f '{{.Mountpoint}}' hetzner_vault-data):/data:ro alpine:3.20 \
     sh -c 'cd /data && tar cz .' \
     | openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt -pass file:/opt/mcp-approval2/.backup-key \
     > /var/backups/mcp-approval2/<DATE>/vault-data.tar.gz.enc
   ```
3. **MANIFEST.txt** — Headers + sha256 der `.enc`-Files (integrity check
   moeglich, ohne den Key zu kennen).
4. **Push to Storage Box** (wenn `STORAGE_BOX_HOST` gesetzt):
   ```bash
   rsync -avz --partial -e "ssh -i ${STORAGE_BOX_SSH_KEY}" \
     /var/backups/mcp-approval2/<DATE>/ \
     $STORAGE_BOX_USER@$STORAGE_BOX_HOST:./mcp-backups/<DATE>/
   ```
5. **Retention-Cleanup** — lokale Daily-Dirs (Naming `YYYY-MM-DD`) aelter
   als 7 Tage werden geloescht. Labelled-Dirs (`YYYY-MM-DD-<label>`) bleiben
   liegen, bis der Operator sie manuell wegraeumt.

Output-Beispiel:
```
→ Dumping approval2...
→ Dumping knowledge2...
→ Snapshotting Vault data (file-backend tar)...
→ Pruning unlabelled local backups older than 7 days...
✓ Backup complete: /var/backups/mcp-approval2/2026-05-16 (164M)
```

### 2. Manual Backup (vor riskanten Updates)

```bash
ssh deploy@${VM_IP}
cd /opt/mcp-approval2/deploy/hetzner
bash backup.sh --label=pre-rotation
# Optional: nur DB, kein Vault:
bash backup.sh --db-only --label=pre-deploy-abc1234
```

Erwartetes Output: Files in `/var/backups/mcp-approval2/<DATE>-<label>/`.
Labelled-Backups werden **nicht** auto-pruned — sie liegen, bis du sie
explizit loeschst.

```bash
ls -lh /var/backups/mcp-approval2/2026-05-16-pre-rotation/
# Expect: approval2.sql.gz.enc + knowledge2.sql.gz.enc + vault-data.tar.gz.enc + MANIFEST.txt
```

### 3. Restore-Verfahren

**WICHTIG:** Restore **immer auf einer Test-VM zuerst** durchspielen.
Niemals direkt auf der Prod-VM ohne Verifikation. Das `restore.sh` setzt
explizite Confirm-Phrase ("YES, RESTORE") voraus.

#### 3.1 Voll-Restore via `restore.sh`

`restore.sh` macht das ganze Paket atomar:

```bash
ssh deploy@${VM_IP}
cd /opt/mcp-approval2/deploy/hetzner

# Backup-Verzeichnis auswaehlen (lokal ODER von Storage-Box gemountet)
bash restore.sh /var/backups/mcp-approval2/2026-05-16-pre-rotation
# bash restore.sh /mnt/storagebox/mcp-backups/2026-05-16
```

Flow:

1. Pre-flight: prueft ob `approval2.sql.gz[.enc]` + `knowledge2.sql.gz[.enc]`
   da sind (auto-detect Encryption per Suffix), prueft MANIFEST.txt-sha256.
2. Operator-Confirm (`YES, RESTORE`).
3. `docker compose stop mcp-approval2 mcp-knowledge2 caddy`.
4. Decrypt → gunzip → `psql` in beide DBs (DROP+restore via `--clean --if-exists`-Dump).
5. Wenn `vault-data.tar.gz[.enc]` vorhanden: `docker compose stop openbao`,
   alpine-Container wipe+tar-restore ins `vault-data`-Volume, `docker compose start openbao`.
6. `docker compose up -d`, `bash healthcheck.sh`.

Erwartetes Output: healthcheck zeigt alle Services OK. **Vault muss
ggf. re-unsealed werden** mit den Original-Keys (Restore stellt die file-
backend Daten wieder her, aber der Container kommt sealed hoch).

#### 3.2 Manueller Sanity-Check eines Backups

Wenn du nur pruefen willst ob ein Backup intakt ist, ohne ihn einzuspielen:

```bash
BACKUP_FILE=/var/backups/mcp-approval2/2026-05-16/approval2.sql.gz.enc

# Decrypt + gunzip + Header-Peek
openssl enc -aes-256-cbc -d -pbkdf2 -iter 100000 \
  -pass file:/opt/mcp-approval2/.backup-key \
  -in "$BACKUP_FILE" \
  | gunzip | head -50
# Expect: lines like "-- PostgreSQL database dump", "SET ...", "DROP ..."

# Checksum-Verifikation gegen MANIFEST.txt
cd /var/backups/mcp-approval2/2026-05-16
sha256sum --check <(grep -E '^[0-9a-f]{64}  \./' MANIFEST.txt)
```

Bei voll-funktionalem Restore-Drill (siehe Verifikation am Ende): die
einzige verlaessliche Pruefung ist Decrypt → gunzip → `psql -d test_db`
und Tabellen-Count zaehlen.

## Troubleshooting

- **Problem:** `openssl enc -d` liefert `bad decrypt`
  → **Loesung:** Backup-Key falsch. Pruefen ob `.backup-key` File-Inhalt
    identisch zum Original (`sha256sum`). Bei pre-2026-05 Backups: pruefe
    ob das Backup ueberhaupt verschluesselt war (alter Pfad: `*.sql.gz`
    ohne `.enc`-Suffix → `restore.sh` faellt automatisch in den
    Plaintext-Pfad zurueck).

- **Problem:** Backup-Skript schlaegt mit `disk full`
  → **Loesung:** `df -h /var/backups`. Retention-Skript laeuft mit jedem
    Backup-Run; wenn dauerhaft voll → Storage-Box konfigurieren ODER
    Volume vergroessern (`hcloud volume resize`).

- **Problem:** `backup.sh` bricht ab mit "backup encryption key not found"
  → **Loesung:** `.backup-key` erzeugen wie in "Voraussetzungen" oben.
    Niemals Plaintext fahren — die Dumps enthalten Approval-Audit-Trails
    + PII.

- **Problem:** Vault-Restore: Container kommt sealed hoch
  → **Loesung:** Das ist erwartet. Mit den Original-Unseal-Keys
    (3-of-N Threshold, default 2) re-unsealen:
    `docker compose exec openbao bao operator unseal <key>` 2x.
    Wenn die Keys verloren sind: data-loss, nur via `bao operator init`
    auf einer frischen Vault-Instance neu aufbauen.

- **Problem:** `restore.sh` will Vault wegen `mismatch in raft cluster id` nicht restoren
  → **Loesung:** Dieser Code-Pfad gibt's nicht mehr. Wir nutzen
    file-backend tar, nicht raft. Sollte der Fehler trotzdem kommen
    (alte Backup-Datei?): pruefe das Backup-Format via
    `file vault-data.tar.gz.enc` — sollte `data` (encrypted) ergeben,
    nicht eine raft-snapshot magic-number.

- **Problem:** DB-Restore wirft `database "approval2" is being accessed by other users`
  → **Loesung:** mcp-approval2 + mcp-knowledge2 Container stoppen vor Restore.
    `restore.sh` macht das automatisch in Step 3. Wenn du manuell
    restoren willst:
    `docker compose stop mcp-approval2 mcp-knowledge2 caddy`.
    Backup-Timer pausieren ist nicht noetig — er ist `Type=oneshot` und
    haelt keine Verbindung.

- **Problem:** Storage Box `rsync` schlaegt mit `Permission denied`
  → **Loesung:** SSH-Key auf Storage Box pruefen. Hetzner-Storage-Boxen
    akzeptieren `ssh-rsa` und neuere — generiere
    `ssh-keygen -t ed25519 -f ~/.ssh/storagebox` und legge den Pub-Key
    in der Hetzner-Web-UI ab. Erste rsync-Run mit
    `-o StrictHostKeyChecking=accept-new` (das macht backup.sh schon).

## Verifikation

Daily-Backup laeuft korrekt:

- [ ] `systemctl status mcp-backup.timer` aktiv + `NextElapseUSecRealtime` in Zukunft
- [ ] `journalctl -u mcp-backup.service -n 50 --no-pager` zeigt erfolgreiche Runs
- [ ] `ls /var/backups/mcp-approval2/ | wc -l` zeigt min. 7 Daily-Dirs nach 1 Woche
- [ ] Letztes Backup juenger als 25 h
  (`stat -c '%y' "$(ls -1d /var/backups/mcp-approval2/*/ | tail -1)"`)
- [ ] Decrypt-Sanity: `openssl enc -d ... | gunzip | head` zeigt Postgres-Dump
- [ ] Storage Box hat juengsten Backup (wenn konfiguriert):
  `ssh u123456@u123456.your-storagebox.de 'ls -1 ./mcp-backups/ | tail -3'`
- [ ] Backup-Encryption-Key noch offline gesichert verfuegbar

Restore-Drill (1× pro Quartal):

- [ ] Test-VM hochfahren (terraform Modul, `instance_name="drill-$(date +%Y%m%d)"`)
- [ ] Backup-Verzeichnis von Storage-Box rsync'en
- [ ] `.backup-key` von der offline-Kopie auf die Drill-VM kopieren
- [ ] `bash restore.sh <backup-dir>`, Confirm geben
- [ ] `/health` 200, bekannte DB-Row lesbar, Vault unsealed
- [ ] Drill-Log mit Zeitstempel + Recovery-Time-Actual + Findings in
  `docs/drills/YYYY-QN-restore-drill.md`
- [ ] Drill-VM zerstoeren

## Migration: pre-2026-05 plaintext Backups

Backups, die vor der Encryption-Migration (2026-05-16) erstellt wurden,
haben kein `.enc`-Suffix (`approval2.sql.gz` statt `approval2.sql.gz.enc`).
`restore.sh` auto-detected das und faellt in den Plaintext-Pfad zurueck —
kein Manual-Eingriff noetig. Trotzdem: solche Backups duerfen **nicht**
auf der Storage Box bleiben (waren ja unverschluesselt geschrieben). Nach
dem ersten Encrypted-Backup-Run:

```bash
ssh u123456@u123456.your-storagebox.de \
  'find ./mcp-backups -name "*.sql.gz" -not -name "*.enc" -delete'
ssh u123456@u123456.your-storagebox.de \
  'find ./mcp-backups -name "vault-data.tar.gz" -not -name "*.enc" -delete'
```

Lokale Plaintext-Backups (≤7 Tage alt) werden vom Retention-Cleanup
automatisch geloescht — keine Manual-Aktion noetig.

## Referenzen

- [PLAN-hetzner-deployment §7 Backup](../plans/active/PLAN-hetzner-deployment.md#backup)
- [runbook-hetzner-disaster-recovery.md](runbook-hetzner-disaster-recovery.md)
- [runbook-hetzner-rotate-vault.md](runbook-hetzner-rotate-vault.md)
- [deploy/hetzner/backup.sh](../../deploy/hetzner/backup.sh)
- [deploy/hetzner/restore.sh](../../deploy/hetzner/restore.sh)
- [deploy/hetzner/systemd/mcp-backup.service](../../deploy/hetzner/systemd/mcp-backup.service)
- [deploy/hetzner/systemd/mcp-backup.timer](../../deploy/hetzner/systemd/mcp-backup.timer)
