#!/usr/bin/env bash
# backup.sh — nightly DB + Vault backup. Stores locally; optionally uploads
# to a Hetzner Storage Box via rsync over SSH.
#
# Run from cron (daily ~03:00 UTC):
#   0 3 * * * /opt/mcp-approval2/deploy/hetzner/backup.sh >> /var/log/mcp-backup.log 2>&1
#
# Output layout:
#   ./backups/<YYYY-MM-DD>/approval2.sql.gz
#                          knowledge2.sql.gz
#                          vault-data.tar.gz   (only if openbao is sealed; live snapshot otherwise)
#                          MANIFEST.txt
#
# Retention: keeps last 7 daily backups locally. Remote retention is the
# Storage Box's job.
#
# Optional env vars (set in /etc/default/mcp-backup or systemd EnvironmentFile):
#   STORAGE_BOX_USER        Hetzner Storage Box user (e.g. u123456)
#   STORAGE_BOX_HOST        u123456.your-storagebox.de
#   STORAGE_BOX_SSH_KEY     path to ssh key (default: ~/.ssh/storagebox)
#   STORAGE_BOX_REMOTE_DIR  remote path (default: ./mcp-backups)

set -euo pipefail

cd "$(dirname "$0")"

BACKUP_ROOT="${BACKUP_ROOT:-./backups}"
DATE=$(date -u +%Y-%m-%d)
DEST="$BACKUP_ROOT/$DATE"
mkdir -p "$DEST"

# ── Sanity ────────────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  echo "ERROR: .env missing." >&2
  exit 1
fi
# shellcheck disable=SC1091
source .env

# ── Step 1: dump approval2 ────────────────────────────────────────────
echo "→ Dumping approval2..."
docker compose exec -T postgres pg_dump \
  -U app -d approval2 --no-owner --clean --if-exists | \
  gzip -9 > "$DEST/approval2.sql.gz"

# ── Step 2: dump knowledge2 ───────────────────────────────────────────
echo "→ Dumping knowledge2..."
docker compose exec -T postgres pg_dump \
  -U app -d knowledge2 --no-owner --clean --if-exists | \
  gzip -9 > "$DEST/knowledge2.sql.gz"

# ── Step 3: snapshot Vault data ──────────────────────────────────────
# OpenBao's file backend is just files. We tar the data directory directly
# from the volume. If Vault is sealed first, the snapshot is consistent.
# For simplicity, we accept a live snapshot — file-backend writes are atomic
# per request, so worst case we miss the last in-flight request.
echo "→ Snapshotting Vault data..."
docker run --rm \
  -v "$(docker volume inspect -f '{{ .Mountpoint }}' \
      "$(basename "$PWD")_vault-data" 2>/dev/null || \
      echo /var/lib/docker/volumes/hetzner_vault-data/_data)":/data:ro \
  -v "$PWD/$DEST":/backup \
  alpine:3.20 \
  sh -c 'cd /data && tar czf /backup/vault-data.tar.gz .' || \
  echo "WARN: vault snapshot failed — check volume name."

# ── Step 4: manifest + checksums ─────────────────────────────────────
{
  echo "Backup created: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Host:           $(hostname)"
  echo "Images:"
  docker compose images --format '  {{.Service}}: {{.Repository}}:{{.Tag}}'
  echo ""
  echo "Files:"
  ( cd "$DEST" && sha256sum ./*.gz ./*.tar.gz 2>/dev/null || true )
} > "$DEST/MANIFEST.txt"

# ── Step 5: optional Storage Box upload ──────────────────────────────
if [[ -n "${STORAGE_BOX_HOST:-}" && -n "${STORAGE_BOX_USER:-}" ]]; then
  echo "→ Uploading to Storage Box ($STORAGE_BOX_USER@$STORAGE_BOX_HOST)..."
  SSH_KEY="${STORAGE_BOX_SSH_KEY:-$HOME/.ssh/storagebox}"
  REMOTE_DIR="${STORAGE_BOX_REMOTE_DIR:-./mcp-backups}"

  rsync -avz --partial \
    -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new" \
    "$DEST" \
    "$STORAGE_BOX_USER@$STORAGE_BOX_HOST:$REMOTE_DIR/" || \
    echo "WARN: rsync to Storage Box failed."
else
  echo "  (skipping Storage Box upload — STORAGE_BOX_HOST not set)"
fi

# ── Step 6: local retention (keep last 7 dirs) ───────────────────────
echo "→ Pruning local backups older than 7 days..."
find "$BACKUP_ROOT" -maxdepth 1 -mindepth 1 -type d -mtime +7 \
  -exec rm -rf {} + 2>/dev/null || true

# ── Done ──────────────────────────────────────────────────────────────
SIZE=$(du -sh "$DEST" | cut -f1)
echo "✓ Backup complete: $DEST ($SIZE)"
