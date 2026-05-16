#!/usr/bin/env bash
# backup.sh — encrypted DB + Vault backup for the Hetzner deploy.
#
# Triggered by systemd timer (deploy/hetzner/systemd/mcp-backup.timer)
# OR invoked manually before risky changes. Re-runs in the same minute
# overwrite the previous artifact in that label-bucket.
#
# Encryption: AES-256-CBC + PBKDF2 (100k iter) + random salt, keyed by
# the file /opt/mcp-approval2/.backup-key (operator-managed, mode 600).
# The key MUST also live offline (paper / USB / another secret store) —
# losing it means losing every encrypted backup.
#
# Output layout:
#   /var/backups/mcp-approval2/<YYYY-MM-DD>[-<label>]/
#     approval2.sql.gz.enc
#     knowledge2.sql.gz.enc
#     vault-data.tar.gz.enc       (omitted when --db-only)
#     MANIFEST.txt                (sha256 of the .enc files)
#
# Retention: keeps last 7 dated dirs locally. Labelled dirs are NEVER
# auto-pruned (they're for "pre-deploy", "pre-rotation" snapshots and
# may be needed weeks later).
#
# Flags:
#   --db-only            skip the vault snapshot
#   --label=NAME         suffix the day-dir with -NAME (e.g. pre-deploy-abc1234)
#   -h | --help          show this help
#
# Optional env vars (set in /etc/default/mcp-backup or systemd EnvironmentFile):
#   BACKUP_KEY_FILE        path to the .backup-key (default: /opt/mcp-approval2/.backup-key)
#   BACKUP_ROOT            local backup root (default: /var/backups/mcp-approval2)
#   STORAGE_BOX_USER       Hetzner Storage Box user (e.g. u123456)
#   STORAGE_BOX_HOST       u123456.your-storagebox.de
#   STORAGE_BOX_SSH_KEY    path to ssh key (default: ~/.ssh/storagebox)
#   STORAGE_BOX_REMOTE_DIR remote path (default: ./mcp-backups)

set -euo pipefail

cd "$(dirname "$0")"

# ── Parse flags ────────────────────────────────────────────────────────
DB_ONLY=false
LABEL=""
for arg in "$@"; do
  case "$arg" in
    --db-only)         DB_ONLY=true ;;
    --label=*)         LABEL="${arg#--label=}" ;;
    -h|--help)         sed -n '2,40p' "$0"; exit 0 ;;
    *)                 echo "ERROR: unknown arg: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# ── Paths + sanity ─────────────────────────────────────────────────────
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/mcp-approval2}"
BACKUP_KEY_FILE="${BACKUP_KEY_FILE:-/opt/mcp-approval2/.backup-key}"
DATE=$(date -u +%Y-%m-%d)
if [[ -n "$LABEL" ]]; then
  DEST="$BACKUP_ROOT/${DATE}-${LABEL}"
else
  DEST="$BACKUP_ROOT/${DATE}"
fi
mkdir -p "$DEST"

if [[ ! -f .env ]]; then
  echo "ERROR: .env missing in $(pwd). Run setup.sh first." >&2
  exit 1
fi
# shellcheck disable=SC1091
source .env

if [[ ! -f "$BACKUP_KEY_FILE" ]]; then
  cat >&2 <<EOF
ERROR: backup encryption key not found at $BACKUP_KEY_FILE

Backups MUST be encrypted at rest — refusing to write plaintext dumps
to disk. Generate the key once and capture it offline:

  sudo install -o deploy -g deploy -m 600 /dev/null "$BACKUP_KEY_FILE"
  openssl rand -base64 48 > "$BACKUP_KEY_FILE"
  cat "$BACKUP_KEY_FILE"   # copy to paper / USB / Doppler vault NOW

Without the key file backed up offline, restoring this backup is
impossible. See docs/runbooks/runbook-hetzner-backup-restore.md.
EOF
  exit 1
fi

# Encryption helper — reads plaintext on stdin, writes ciphertext to "$1".
# AES-256-CBC + PBKDF2 (100k iterations matches LUKS defaults).
encrypt_to() {
  openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt \
    -pass "file:$BACKUP_KEY_FILE" \
    -out "$1"
}

# ── Step 1: dump approval2 ─────────────────────────────────────────────
echo "→ Dumping approval2..."
docker compose exec -T postgres pg_dump \
  -U app -d approval2 --no-owner --clean --if-exists | \
  gzip -9 | encrypt_to "$DEST/approval2.sql.gz.enc"

# ── Step 2: dump knowledge2 ────────────────────────────────────────────
echo "→ Dumping knowledge2..."
docker compose exec -T postgres pg_dump \
  -U app -d knowledge2 --no-owner --clean --if-exists | \
  gzip -9 | encrypt_to "$DEST/knowledge2.sql.gz.enc"

# ── Step 3: snapshot Vault data (skip when --db-only) ──────────────────
# OpenBao runs with `storage "file"` (docker-compose.yml), so we tar the
# data directory directly. The runbook used to spec `raft snapshot save`
# — that requires raft-backend and would fail here. We accept a live
# snapshot (file-backend writes are atomic per request; worst case the
# in-flight write is missed).
if [[ "$DB_ONLY" == "true" ]]; then
  echo "  (skipping Vault snapshot — --db-only)"
else
  echo "→ Snapshotting Vault data (file-backend tar)..."
  VAULT_MOUNT="$(docker volume inspect \
    -f '{{ .Mountpoint }}' \
    "$(basename "$PWD")_vault-data" 2>/dev/null || \
    echo "/var/lib/docker/volumes/hetzner_vault-data/_data")"
  docker run --rm \
    -v "$VAULT_MOUNT":/data:ro \
    alpine:3.20 \
    sh -c 'cd /data && tar cz .' \
    | encrypt_to "$DEST/vault-data.tar.gz.enc" \
    || echo "WARN: vault snapshot failed — check volume name."
fi

# ── Step 4: manifest + checksums ───────────────────────────────────────
{
  echo "Backup created: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Host:           $(hostname)"
  echo "Label:          ${LABEL:-<none>}"
  echo "DB-only:        $DB_ONLY"
  echo "Encryption:     AES-256-CBC + PBKDF2 (100k iter)"
  echo "Key file:       $BACKUP_KEY_FILE"
  echo ""
  echo "Images at backup time:"
  docker compose images --format '  {{.Service}}: {{.Repository}}:{{.Tag}}'
  echo ""
  echo "Files (sha256 of ciphertext):"
  ( cd "$DEST" && sha256sum ./*.enc 2>/dev/null || true )
} > "$DEST/MANIFEST.txt"

# ── Step 5: optional Storage Box upload ────────────────────────────────
if [[ -n "${STORAGE_BOX_HOST:-}" && -n "${STORAGE_BOX_USER:-}" ]]; then
  echo "→ Uploading to Storage Box ($STORAGE_BOX_USER@$STORAGE_BOX_HOST)..."
  SSH_KEY="${STORAGE_BOX_SSH_KEY:-$HOME/.ssh/storagebox}"
  REMOTE_DIR="${STORAGE_BOX_REMOTE_DIR:-./mcp-backups}"

  rsync -avz --partial \
    -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new" \
    "$DEST" \
    "$STORAGE_BOX_USER@$STORAGE_BOX_HOST:$REMOTE_DIR/" \
    || echo "WARN: rsync to Storage Box failed."
else
  echo "  (skipping Storage Box upload — STORAGE_BOX_HOST not set)"
fi

# ── Step 6: local retention (unlabelled dirs only, last 7 dated dirs) ──
# Labelled dirs are NEVER auto-pruned — they're explicit operator-pinned
# snapshots and we don't know when the operator will want them back.
echo "→ Pruning unlabelled local backups older than 7 days..."
find "$BACKUP_ROOT" -maxdepth 1 -mindepth 1 -type d \
  -regextype posix-extended -regex '.*/[0-9]{4}-[0-9]{2}-[0-9]{2}$' \
  -mtime +7 -exec rm -rf {} + 2>/dev/null || true

# ── Done ───────────────────────────────────────────────────────────────
SIZE=$(du -sh "$DEST" | cut -f1)
echo "✓ Backup complete: $DEST ($SIZE)"
