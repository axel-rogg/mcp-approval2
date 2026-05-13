# Runbook: Hetzner Vault-Token + AppRole-Rotation

> **Status:** Ready
> **Letzte Verifikation:** 2026-05-13
> **Estimated time:** 15 min (AppRole) / 30 min (Root-Token) / 60 min (Transit-Key) / 2-4 h (Unseal-Keys)

OpenBao laeuft auf der Hetzner-VM als KEK + Transit-Engine. Vier
Rotation-Klassen mit unterschiedlicher Cadence:

| Rotation | Cadence | Impact |
|---|---|---|
| AppRole secret_id | 90 Tage | Keiner (atomic) |
| Root-Token | jaehrlich | Operator-Only |
| Transit-Key (KEK) | jaehrlich | Re-Wrap aller DEKs noetig |
| Unseal-Keys | nur bei Compromise | Vault-Rebuild |

## Voraussetzungen

- Vault ist **unsealed** und erreichbar
  - `docker compose exec openbao bao status` zeigt `Sealed: false`
- Operator-Access (Root-Token oder Admin-Policy)
  - Root-Token aus offline-backup geladen, **NIE in .env oder Logs**
- **Aktuelles Backup vorhanden** (siehe [runbook-hetzner-backup-restore.md](runbook-hetzner-backup-restore.md))
  - Vault-Data-Volume snapshot < 24 h
  - DB-Dump < 24 h (wegen DEK-encrypted Spalten)
- SSH zur VM als `deploy`-User

## Schritte

### 1. AppRole secret_id rotation (alle 90 Tage)

mcp-approval2 + mcp-knowledge2 authentifizieren sich gegen Vault per AppRole.
Die `secret_id` ist short-lived und MUSS rotiert werden.

```bash
ssh deploy@${VM_IP}
cd /opt/mcp-approval2

# Root-Token aus offline-backup laden (NICHT in History!)
read -rs VAULT_ROOT_TOKEN
export VAULT_ROOT_TOKEN

# Neue secret_id generieren fuer mcp-approval2
NEW_SID=$(docker compose exec -T -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" openbao \
  bao write -force -field=secret_id auth/approle/role/mcp-approval2/secret-id)

# .env update (nur die eine Zeile)
sed -i.bak "s|^VAULT_APPROLE_SECRET_ID=.*|VAULT_APPROLE_SECRET_ID=${NEW_SID}|" .env
shred -u .env.bak

# Selbe Prozedur fuer mcp-knowledge2
NEW_SID_K=$(docker compose exec -T -e VAULT_TOKEN="$VAULT_ROOT_TOKEN" openbao \
  bao write -force -field=secret_id auth/approle/role/mcp-knowledge2/secret-id)
sed -i.bak "s|^KNOWLEDGE_VAULT_APPROLE_SECRET_ID=.*|KNOWLEDGE_VAULT_APPROLE_SECRET_ID=${NEW_SID_K}|" .env
shred -u .env.bak

# Rolling-Restart (Vault-Auth wird beim Container-Start refreshed)
docker compose -f deploy/hetzner/docker-compose.yml up -d mcp-approval2 mcp-knowledge2

# Audit
docker compose logs --tail=20 mcp-approval2 | grep -i "vault.*auth"
# Expect: "vault auth success role=mcp-approval2"

unset VAULT_ROOT_TOKEN
```

Erwartetes Output: keine 503-Errors auf `/health`, beide Services laufen weiter.

### 2. Root-Token rotation (jaehrlich)

Root-Token wird nur fuer Break-Glass benutzt — Rotation entwertet die alte
Kopie und erzeugt eine neue.

```bash
ssh deploy@${VM_IP}
cd /opt/mcp-approval2

# Aktuelles Root-Token aus offline-backup laden
read -rs OLD_ROOT
export VAULT_TOKEN="$OLD_ROOT"

# Neuen Root-Token generieren (mit Multi-Step-Process)
docker compose exec openbao bao operator generate-root -init -otp=$(openssl rand -base64 24 | head -c 24)
# → OTP + Nonce notieren

# Mit 2 Unseal-Keys signieren
docker compose exec openbao bao operator generate-root -nonce=<NONCE> <UNSEAL-KEY-1>
docker compose exec openbao bao operator generate-root -nonce=<NONCE> <UNSEAL-KEY-2>
# → encoded-token wird ausgegeben

# Decode mit OTP
NEW_ROOT=$(docker compose exec openbao bao operator generate-root -decode=<encoded-token> -otp=<OTP>)

# Alten Root-Token revoken
docker compose exec -e VAULT_TOKEN="$OLD_ROOT" openbao bao token revoke "$OLD_ROOT"

# Neuen Token verifizieren
docker compose exec -e VAULT_TOKEN="$NEW_ROOT" openbao bao token lookup
# Expect: policies=[root], ttl=0 (never expires)

# Offline-Backup updaten (Paper-Wallet + verschluesselter USB)
echo "$NEW_ROOT" | gpg --symmetric --armor > /tmp/vault-root.gpg
# Manuell auf Backup-Medium kopieren, dann:
shred -u /tmp/vault-root.gpg

unset VAULT_TOKEN OLD_ROOT NEW_ROOT
```

Erwartetes Output: alter Root-Token liefert `permission denied`, neuer
funktioniert.

### 3. Transit-Key rotation (jaehrlich, mit Re-Wrap der DEKs)

KEK (Key Encryption Key) im Transit-Engine wird rotiert. Alte DEKs (Data
Encryption Keys) muessen mit dem neuen KEK re-wrapped werden.

```bash
ssh deploy@${VM_IP}
cd /opt/mcp-approval2

# Pre-Flight: Backup von DB + Vault VOR Rotation
bash deploy/hetzner/backup.sh --tag pre-kek-rotation

# Root-Token laden
read -rs VAULT_ROOT_TOKEN
export VAULT_TOKEN="$VAULT_ROOT_TOKEN"

# Aktuelle Key-Version pruefen
docker compose exec openbao bao read transit/keys/mcp-approval2-kek
# Expect: latest_version=N

# Rotation triggern (KEK bekommt neue Version N+1)
docker compose exec openbao bao write -f transit/keys/mcp-approval2-kek/rotate

# Re-Wrap-Skript laufen lassen (in mcp-approval2 Container)
docker compose exec mcp-approval2 node scripts/rewrap-deks.js --kek=mcp-approval2-kek

# Erwartetes Output:
# Processing 142 credentials...
# Processing 56 gateway_oauth_tokens...
# Re-wrap COMPLETE: 198/198 rows updated, 0 errors
# All DEKs now reference key version N+1

# Min-Decryption-Version setzen (alte Versionen unbrauchbar)
docker compose exec openbao bao write transit/keys/mcp-approval2-kek/config \
  min_decryption_version=N+1

# Selbe Prozedur fuer mcp-knowledge2
docker compose exec openbao bao write -f transit/keys/mcp-knowledge2-kek/rotate
docker compose exec mcp-knowledge2 node scripts/rewrap-deks.js --kek=mcp-knowledge2-kek
docker compose exec openbao bao write transit/keys/mcp-knowledge2-kek/config \
  min_decryption_version=N+1

# Smoke
bash deploy/hetzner/healthcheck.sh

unset VAULT_TOKEN VAULT_ROOT_TOKEN
```

Erwartetes Output: alle Credentials weiterhin lesbar, neue Writes verwenden
key-version N+1.

### 4. Unseal-Keys rotation (rebuild Vault)

Nur bei Verdacht auf Compromise eines Unseal-Key-Holders. Triggert
Vault-Rebuild + Re-Init.

```bash
ssh deploy@${VM_IP}
cd /opt/mcp-approval2

# Vorab: Vollstaendiges Backup
bash deploy/hetzner/backup.sh --tag pre-unseal-rotation

# Vault snapshot fuer Recovery
docker compose exec openbao bao operator raft snapshot save /vault/data/snapshot.snap
docker cp $(docker compose ps -q openbao):/vault/data/snapshot.snap ./vault-snapshot-$(date +%Y%m%d).snap

# rekey-Operation initialisieren
read -rs VAULT_ROOT_TOKEN
export VAULT_TOKEN="$VAULT_ROOT_TOKEN"

docker compose exec openbao bao operator rekey -init \
  -key-shares=3 -key-threshold=2

# Nonce notieren
# Dann mit 2 von 3 ALTEN Unseal-Keys den rekey signieren:
docker compose exec openbao bao operator rekey -nonce=<NONCE> <OLD-KEY-1>
docker compose exec openbao bao operator rekey -nonce=<NONCE> <OLD-KEY-2>
# → 3 NEUE Unseal-Keys werden ausgegeben

# NEUE Keys SOFORT offline backupen (Paper + USB)
# Dann ALTE Keys aus allen Backup-Medien shred-en
# Dann:
unset VAULT_TOKEN VAULT_ROOT_TOKEN
```

Erwartetes Output: `bao status` zeigt weiterhin `unsealed`, aber die 3 alten
Unseal-Keys funktionieren nicht mehr.

## Troubleshooting

- **Problem:** `bao write` liefert `permission denied`
  → **Loesung:** Token-Policy pruefen — Root-Token notwendig fuer alle
    Rotation-Ops. `bao token lookup` zeigt aktuelle Policies.

- **Problem:** Re-Wrap-Skript bricht mit `key version N not found`
  → **Loesung:** `min_decryption_version` zu frueh gesetzt. Auf 0 zuruecksetzen
    via `bao write transit/keys/.../config min_decryption_version=0`,
    Re-Wrap retten, dann erneut min_decryption_version setzen.

- **Problem:** Nach Rotation 503 auf `/health`
  → **Loesung:** Vault sealed checken (`bao status`). Falls unsealed, dann
    `mcp-approval2` logs lesen — wahrscheinlich AppRole-Auth-Issue weil
    secret_id und role_id mismatch.

- **Problem:** rekey-Operation haengt bei `nonce expired`
  → **Loesung:** Nonces sind 10-min-gueltig. Bei Verzoegerung neu starten
    via `bao operator rekey -cancel`, dann `-init`.

- **Problem:** Re-Wrap-Skript haengt bei grossem Datenvolumen
  → **Loesung:** `--batch-size=50` Flag (default 100). Bei >10k Credentials
    in Off-Peak-Window laufen lassen.

## Verifikation

Nach jeder Rotation:

- [ ] `bao status` zeigt unsealed
- [ ] `docker compose logs mcp-approval2 | grep -i error` keine Auth-Errors
- [ ] `curl https://mcp2.ai-toolhub.org/health` liefert 200
- [ ] Random-Credential aus DB ist via App entschluesselbar (manueller Test)
- [ ] Offline-Backup der NEUEN Geheimnisse verifiziert (gpg --decrypt Test)
- [ ] Alte Geheimnisse aus allen Medien shredded

### Audit-Log-Verification

```bash
docker compose exec openbao bao audit list
# Expect: file-audit auf /vault/data/audit.log

docker compose exec openbao tail -100 /vault/data/audit.log | jq .
# Expect: Rotation-Events als JSON-Lines mit type="response"
```

## Referenzen

- [PLAN-hetzner-deployment §7 Rotation](../plans/active/PLAN-hetzner-deployment.md#rotation)
- [runbook-token-rotation.md](runbook-token-rotation.md) — Application-Level Tokens (JWT, INTERNAL)
- [runbook-hetzner-backup-restore.md](runbook-hetzner-backup-restore.md)
- [OpenBao Transit-Engine Docs](https://openbao.org/docs/secrets/transit/)
