#!/usr/bin/env bash
# restore.sh — restore approval2 + knowledge2 + Vault from a backup directory.
#
# DANGER: this WIPES the current DBs and Vault data. Confirm explicitly.
#
# Usage:
#   bash restore.sh ./backups/2026-05-13
#   bash restore.sh /mnt/storagebox/mcp-backups/2026-05-13
#
# Flow:
#   1. Pre-flight checks (files exist, sha256 matches if MANIFEST present)
#   2. Confirm with operator (type 'YES, RESTORE' to proceed)
#   3. docker compose down (stops services, keeps named volumes)
#   4. drop+recreate DBs from the dump files
#   5. restore Vault data tar over the vault-data volume
#   6. docker compose up -d
#   7. healthcheck

set -euo pipefail

cd "$(dirname "$0")"

if [[ $# -lt 1 ]]; then
  echo "Usage: bash restore.sh <backup-directory>" >&2
  echo "Example: bash restore.sh ./backups/2026-05-13" >&2
  exit 1
fi

SRC="$1"

if [[ ! -d "$SRC" ]]; then
  echo "ERROR: backup directory '$SRC' not found." >&2
  exit 1
fi

# ── Step 1: pre-flight ────────────────────────────────────────────────
for f in approval2.sql.gz knowledge2.sql.gz; do
  if [[ ! -f "$SRC/$f" ]]; then
    echo "ERROR: missing $SRC/$f" >&2
    exit 1
  fi
done

if [[ -f "$SRC/MANIFEST.txt" ]]; then
  echo "→ Verifying checksums against MANIFEST.txt..."
  ( cd "$SRC" && sha256sum --check --status \
    <(grep -E '^[0-9a-f]{64}  \./' MANIFEST.txt) ) || {
    echo "ERROR: checksum mismatch in $SRC. Refusing to restore." >&2
    exit 1
  }
  echo "  ✓ checksums OK"
fi

# ── Step 2: confirm ───────────────────────────────────────────────────
echo ""
echo "⚠ This will OVERWRITE approval2 + knowledge2 + Vault data."
echo "  Source: $SRC"
echo "  Files:"
ls -lh "$SRC"
echo ""
read -r -p "Type 'YES, RESTORE' to continue: " CONFIRM
if [[ "$CONFIRM" != "YES, RESTORE" ]]; then
  echo "Aborted."
  exit 1
fi

# ── Step 3: stop services that hold DB connections ────────────────────
# Keep postgres + openbao up (we restore through them).
echo "→ Stopping app containers..."
docker compose stop mcp-approval2 mcp-knowledge2 caddy

# ── Step 4: restore DBs ───────────────────────────────────────────────
echo "→ Restoring approval2..."
gunzip -c "$SRC/approval2.sql.gz" | \
  docker compose exec -T postgres psql -U app -d approval2 -v ON_ERROR_STOP=1

echo "→ Restoring knowledge2..."
gunzip -c "$SRC/knowledge2.sql.gz" | \
  docker compose exec -T postgres psql -U app -d knowledge2 -v ON_ERROR_STOP=1

# ── Step 5: restore Vault (optional — only if file present) ──────────
if [[ -f "$SRC/vault-data.tar.gz" ]]; then
  echo "→ Restoring Vault data (stopping openbao first)..."
  docker compose stop openbao

  VOLUME_NAME=$(docker volume ls --format '{{.Name}}' | grep vault-data | head -1)
  if [[ -z "$VOLUME_NAME" ]]; then
    echo "ERROR: could not find vault-data volume." >&2
    exit 1
  fi

  MOUNT=$(docker volume inspect -f '{{ .Mountpoint }}' "$VOLUME_NAME")

  # Wipe + restore. Run in an ephemeral alpine container with root privs.
  docker run --rm \
    -v "$MOUNT":/data \
    -v "$PWD/$SRC":/backup:ro \
    alpine:3.20 \
    sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/vault-data.tar.gz -C /data'

  docker compose start openbao
  echo "  → Vault restored. You may need to re-unseal with the original keys."
else
  echo "  (skipping Vault restore — no vault-data.tar.gz in source)"
fi

# ── Step 6: restart services ──────────────────────────────────────────
echo "→ Restarting services..."
docker compose up -d

# ── Step 7: healthcheck ───────────────────────────────────────────────
echo "→ Running healthcheck (allow ~30s for services to settle)..."
sleep 5
bash healthcheck.sh || echo "WARN: healthcheck reported issues."

echo "✓ Restore complete."
