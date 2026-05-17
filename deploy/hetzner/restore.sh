#!/usr/bin/env bash
# restore.sh — restore approval2 + knowledge2 + Vault from a backup directory.
#
# DANGER: this WIPES the current DBs and Vault data. Confirm explicitly.
#
# Auto-detects encrypted (.enc) vs legacy plaintext (.gz / .tar.gz) artifacts.
# Encrypted backups need /opt/mcp-approval2/.backup-key — same key file
# backup.sh used at create time. Without it: irrecoverable.
#
# Usage:
#   bash restore.sh /var/backups/mcp-approval2/2026-05-13
#   bash restore.sh /var/backups/mcp-approval2/2026-05-13-pre-deploy-abc1234
#   bash restore.sh /mnt/storagebox/mcp-backups/2026-05-13
#
# Flow:
#   1. Pre-flight (files exist, key present if .enc, MANIFEST checksums)
#   2. Confirm with operator (type 'YES, RESTORE' to proceed)
#   3. docker compose stop app containers (keeps named volumes)
#   4. Decrypt + drop+recreate DBs from the dump files
#   5. Restore Vault data tar over the vault-data volume
#   6. docker compose up -d
#   7. healthcheck

set -euo pipefail

cd "$(dirname "$0")"

if [[ $# -lt 1 ]]; then
  echo "Usage: bash restore.sh <backup-directory>" >&2
  echo "Example: bash restore.sh /var/backups/mcp-approval2/2026-05-13" >&2
  exit 1
fi

SRC="$1"
BACKUP_KEY_FILE="${BACKUP_KEY_FILE:-/opt/mcp-approval2/.backup-key}"

if [[ ! -d "$SRC" ]]; then
  echo "ERROR: backup directory '$SRC' not found." >&2
  exit 1
fi

# ── Auto-detect encryption + naming ────────────────────────────────────
# New format: <db>.sql.gz.enc / vault-data.tar.gz.enc
# Old format: <db>.sql.gz     / vault-data.tar.gz
APPROVAL_ENC="$SRC/approval2.sql.gz.enc"
APPROVAL_PT="$SRC/approval2.sql.gz"
KNOWLEDGE_ENC="$SRC/knowledge2.sql.gz.enc"
KNOWLEDGE_PT="$SRC/knowledge2.sql.gz"
VAULT_ENC="$SRC/vault-data.tar.gz.enc"
VAULT_PT="$SRC/vault-data.tar.gz"

if [[ -f "$APPROVAL_ENC" ]]; then
  APPROVAL_SRC="$APPROVAL_ENC"; APPROVAL_ENCRYPTED=true
elif [[ -f "$APPROVAL_PT" ]]; then
  APPROVAL_SRC="$APPROVAL_PT"; APPROVAL_ENCRYPTED=false
else
  echo "ERROR: missing approval2 dump in $SRC (looked for *.enc + plaintext)" >&2; exit 1
fi
if [[ -f "$KNOWLEDGE_ENC" ]]; then
  KNOWLEDGE_SRC="$KNOWLEDGE_ENC"; KNOWLEDGE_ENCRYPTED=true
elif [[ -f "$KNOWLEDGE_PT" ]]; then
  KNOWLEDGE_SRC="$KNOWLEDGE_PT"; KNOWLEDGE_ENCRYPTED=false
else
  echo "ERROR: missing knowledge2 dump in $SRC" >&2; exit 1
fi
VAULT_SRC=""
VAULT_ENCRYPTED=false
if [[ -f "$VAULT_ENC" ]]; then
  VAULT_SRC="$VAULT_ENC"; VAULT_ENCRYPTED=true
elif [[ -f "$VAULT_PT" ]]; then
  VAULT_SRC="$VAULT_PT"
fi

ANY_ENCRYPTED=false
$APPROVAL_ENCRYPTED  && ANY_ENCRYPTED=true
$KNOWLEDGE_ENCRYPTED && ANY_ENCRYPTED=true
$VAULT_ENCRYPTED     && ANY_ENCRYPTED=true

if $ANY_ENCRYPTED && [[ ! -f "$BACKUP_KEY_FILE" ]]; then
  echo "ERROR: backup is encrypted but $BACKUP_KEY_FILE missing." >&2
  echo "       Restore the key file from your offline copy first." >&2
  exit 1
fi

# Decryption helper — reads ciphertext on stdin, writes plaintext to stdout.
decrypt_from() {
  openssl enc -aes-256-cbc -d -pbkdf2 -iter 100000 \
    -pass "file:$BACKUP_KEY_FILE" \
    -in "$1"
}

# ── Step 1: MANIFEST sha256 verification ───────────────────────────────
if [[ -f "$SRC/MANIFEST.txt" ]]; then
  echo "→ Verifying checksums against MANIFEST.txt..."
  CHECKSUM_LINES="$(grep -E '^[0-9a-f]{64}  \./' "$SRC/MANIFEST.txt" || true)"
  if [[ -n "$CHECKSUM_LINES" ]]; then
    ( cd "$SRC" && sha256sum --check --status <(echo "$CHECKSUM_LINES") ) || {
      echo "ERROR: checksum mismatch in $SRC. Refusing to restore." >&2
      exit 1
    }
    echo "  ✓ checksums OK"
  else
    echo "  (MANIFEST has no checksum lines — skipping)"
  fi
fi

# ── Step 2: confirm ────────────────────────────────────────────────────
echo ""
echo "⚠ This will OVERWRITE approval2 + knowledge2 + Vault data."
echo "  Source:          $SRC"
echo "  approval2 from:  $(basename "$APPROVAL_SRC")   encrypted=$APPROVAL_ENCRYPTED"
echo "  knowledge2 from: $(basename "$KNOWLEDGE_SRC")  encrypted=$KNOWLEDGE_ENCRYPTED"
if [[ -n "$VAULT_SRC" ]]; then
  echo "  vault from:      $(basename "$VAULT_SRC")  encrypted=$VAULT_ENCRYPTED"
else
  echo "  vault:           (not in backup — Vault data will be left untouched)"
fi
echo ""
read -r -p "Type 'YES, RESTORE' to continue: " CONFIRM
if [[ "$CONFIRM" != "YES, RESTORE" ]]; then
  echo "Aborted."
  exit 1
fi

# ── Step 3: stop services that hold DB connections ─────────────────────
echo "→ Stopping app containers..."
docker compose stop mcp-approval2 mcp-knowledge2 caddy

# ── Step 4: restore DBs ────────────────────────────────────────────────
restore_db() {
  local src="$1" enc="$2" db="$3"
  echo "→ Restoring $db..."
  if [[ "$enc" == "true" ]]; then
    decrypt_from "$src" | gunzip | \
      docker compose exec -T postgres psql -U app -d "$db" -v ON_ERROR_STOP=1
  else
    gunzip -c "$src" | \
      docker compose exec -T postgres psql -U app -d "$db" -v ON_ERROR_STOP=1
  fi
}
restore_db "$APPROVAL_SRC"  "$APPROVAL_ENCRYPTED"  approval2
restore_db "$KNOWLEDGE_SRC" "$KNOWLEDGE_ENCRYPTED" knowledge2

# ── Step 5: restore Vault (only if file present) ───────────────────────
if [[ -n "$VAULT_SRC" ]]; then
  echo "→ Restoring Vault data (stopping openbao first)..."
  docker compose stop openbao

  VOLUME_NAME=$(docker volume ls --format '{{.Name}}' | grep vault-data | head -1)
  if [[ -z "$VOLUME_NAME" ]]; then
    echo "ERROR: could not find vault-data volume." >&2
    exit 1
  fi
  MOUNT=$(docker volume inspect -f '{{ .Mountpoint }}' "$VOLUME_NAME")

  # Wipe + restore. Pipe through openssl when encrypted; else stream the
  # plaintext tar straight in. Either way the alpine container untars
  # into /data and we run with root privs to bypass volume permissions.
  if [[ "$VAULT_ENCRYPTED" == "true" ]]; then
    decrypt_from "$VAULT_SRC" | \
      docker run --rm -i \
        -v "$MOUNT":/data \
        alpine:3.20 \
        sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf - -C /data'
  else
    docker run --rm \
      -v "$MOUNT":/data \
      -v "$PWD/$SRC":/backup:ro \
      alpine:3.20 \
      sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/vault-data.tar.gz -C /data'
  fi

  docker compose start openbao
  echo "  → Vault restored. Re-unseal with the original keys before any traffic hits."
else
  echo "  (no vault-data.tar.gz[.enc] in source — Vault data untouched)"
fi

# ── Step 6: restart services ───────────────────────────────────────────
echo "→ Restarting services..."
docker compose up -d

# ── Step 7: healthcheck ────────────────────────────────────────────────
echo "→ Running healthcheck (allow ~30s for services to settle)..."
sleep 5
bash healthcheck.sh || echo "WARN: healthcheck reported issues."

echo "✓ Restore complete."
