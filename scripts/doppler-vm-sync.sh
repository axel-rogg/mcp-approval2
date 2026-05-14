#!/usr/bin/env bash
# doppler-vm-sync.sh — pull current Doppler secrets into the VM's .env-file.
#
# Runs on the Hetzner VM as the `deploy` user. Driven by:
#   /opt/mcp-approval2/.doppler-token   # chmod 600, single line, no quotes
#
# Output:
#   /opt/mcp-approval2/deploy/hetzner/.env (chmod 600, atomic replace)
#
# Designed to be wired into setup.sh and into a systemd-timer / cron for
# automatic re-sync after secret-rotation in Doppler. Atomic write (`.tmp`
# -> `mv`) guarantees that a half-finished download never leaves `.env`
# in an inconsistent state for the running containers.
#
# Override via env-vars (useful for staging the script before final paths):
#   DOPPLER_TOKEN_FILE   — path to the service-token file
#                          (default: /opt/mcp-approval2/.doppler-token)
#   ENV_FILE             — output path for the rendered .env
#                          (default: /opt/mcp-approval2/deploy/hetzner/.env)

set -euo pipefail

DOPPLER_TOKEN_FILE="${DOPPLER_TOKEN_FILE:-/opt/mcp-approval2/.doppler-token}"
ENV_FILE="${ENV_FILE:-/opt/mcp-approval2/deploy/hetzner/.env}"

# ── 1. doppler-cli present? ────────────────────────────────────────────
if ! command -v doppler >/dev/null 2>&1; then
  echo "ERR: doppler-cli not installed on this host." >&2
  echo "     Install: curl -Ls --tlsv1.2 --proto '=https' --retry 3 \\" >&2
  echo "              https://cli.doppler.com/install.sh | sh" >&2
  exit 1
fi

# ── 2. Token-file present? ─────────────────────────────────────────────
if [[ ! -f "$DOPPLER_TOKEN_FILE" ]]; then
  echo "ERR: Doppler token-file not found: $DOPPLER_TOKEN_FILE" >&2
  echo "     Create it (on operator workstation):" >&2
  echo "       cd terraform/environments/privat" >&2
  echo "       terraform output -raw doppler_vm_token" >&2
  echo "     Then on the VM:" >&2
  echo "       echo 'dp.st.privat.xxx' > $DOPPLER_TOKEN_FILE" >&2
  echo "       chmod 600 $DOPPLER_TOKEN_FILE" >&2
  exit 1
fi

# ── 3. Read token (security: strip whitespace, never echo) ─────────────
TOKEN="$(tr -d ' \n\r' < "$DOPPLER_TOKEN_FILE")"

if [[ -z "$TOKEN" ]]; then
  echo "ERR: Token-file is empty: $DOPPLER_TOKEN_FILE" >&2
  exit 1
fi

# ── 4. Download secrets into a temp file ───────────────────────────────
# We pipe via a temp-file so that a partial / failed download never
# corrupts the running .env. `--no-file` makes the CLI print to stdout;
# `--format env` emits KEY=VALUE lines.
TMP_FILE="${ENV_FILE}.tmp"
ENV_DIR="$(dirname "$ENV_FILE")"
mkdir -p "$ENV_DIR"

echo "-> Downloading secrets from Doppler ..."
if ! DOPPLER_TOKEN="$TOKEN" doppler secrets download \
       --no-file \
       --format env \
       > "$TMP_FILE" 2>/dev/null; then
  echo "ERR: Doppler-sync failed. Re-running with stderr visible:" >&2
  DOPPLER_TOKEN="$TOKEN" doppler secrets download \
    --no-file --format env >/dev/null || true
  rm -f "$TMP_FILE"
  exit 1
fi

# ── 5. Atomic replace + permissions ────────────────────────────────────
mv "$TMP_FILE" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Count rendered vars (lines matching KEY=...). The `|| true` guards
# `grep -c` exiting 1 on zero matches under `set -e`.
LINE_COUNT="$(grep -c '^[A-Z_][A-Z0-9_]*=' "$ENV_FILE" || true)"

echo "OK: .env synced from Doppler — ${LINE_COUNT:-0} vars in $ENV_FILE"
