#!/usr/bin/env bash
# doppler-bootstrap.sh — one-shot Doppler setup helper for mcp-approval2.
#
# What it does:
#   1. Installs doppler-cli if missing.
#   2. Ensures the user is authenticated (via DOPPLER_TOKEN env-var or
#      interactive `doppler login`).
#   3. Maps the current repo directory to project=mcp-approval2 config=privat.
#   4. Prints a summary of secret-counts + lists any empty placeholders so the
#      operator knows which ones still need to be filled in the Doppler UI.
#
# Idempotent: re-running is safe.
#
# Prereqs: nothing. Cold-start friendly.
#
# Usage:
#   bash scripts/doppler-bootstrap.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==========================================================="
echo "  Doppler Bootstrap for mcp-approval2"
echo "==========================================================="

# ── 1. doppler-cli check + install if needed ───────────────────────────
if ! command -v doppler >/dev/null 2>&1; then
  echo "-> Installing doppler-cli ..."
  curl -Ls --tlsv1.2 --proto '=https' --retry 3 \
    https://cli.doppler.com/install.sh | sh
else
  echo "-> doppler-cli already installed: $(doppler --version)"
fi

# ── 2. Auth-check ──────────────────────────────────────────────────────
# `doppler me` exits non-zero when no auth is present. If DOPPLER_TOKEN is
# set, the CLI uses it automatically — we just need to confirm it works.
if [[ -z "${DOPPLER_TOKEN:-}" ]] && ! doppler me >/dev/null 2>&1; then
  echo "-> Doppler login required (opens browser) ..."
  doppler login
fi

# ── 3. Workplace info (sanity output) ──────────────────────────────────
echo "-> Connected to Doppler as:"
doppler me || {
  echo "ERROR: Doppler auth still failing after login attempt." >&2
  exit 1
}

# ── 4. Repo mapping ────────────────────────────────────────────────────
cd "$REPO_ROOT"
echo "-> Mapping repo to project=mcp-approval2, config=privat ..."
# `--no-interactive` skips the workplace-picker prompt when only one option
# matches. We tail the last 5 lines just to keep output tidy.
doppler setup --project mcp-approval2 --config privat --no-interactive 2>&1 \
  | tail -n 5

# ── 5. Secret-status summary ───────────────────────────────────────────
echo ""
echo "-> Checking secret-counts in config 'privat' ..."

SECRET_LIST="$(doppler secrets --only-names 2>/dev/null || echo "")"
SECRET_COUNT="$(printf '%s\n' "$SECRET_LIST" | grep -c . || true)"

if [[ "${SECRET_COUNT:-0}" -eq 0 ]]; then
  echo "   WARN: No secrets found in this config."
  echo "         Did 'terraform apply' run in terraform/environments/privat?"
  echo "         If yes, are you in the correct Doppler workplace?"
else
  echo "   Total secrets:           $SECRET_COUNT"

  # Count empty values. `doppler secrets --json` returns
  #   { "KEY": { "computed": "...", "raw": "...", "note": "..." }, ... }
  # We count entries where `computed` is empty-string or null.
  EMPTY_COUNT="$(
    doppler secrets --json 2>/dev/null \
      | jq -r '[to_entries[] | select(.value.computed == "" or .value.computed == null)] | length' \
      2>/dev/null || echo "?"
  )"
  echo "   Empty (TODO to fill in): $EMPTY_COUNT"

  if [[ "$EMPTY_COUNT" != "?" && "${EMPTY_COUNT:-0}" -gt 0 ]]; then
    echo ""
    echo "   $EMPTY_COUNT secret(s) are empty. Fill them in the Doppler UI:"
    echo "     https://dashboard.doppler.com/workplace/projects/mcp-approval2"
    echo ""
    doppler secrets --json 2>/dev/null \
      | jq -r 'to_entries[]
               | select(.value.computed == "" or .value.computed == null)
               | "     - " + .key' \
      2>/dev/null || true
  fi
fi

echo ""
echo "==========================================================="
echo "  Bootstrap complete."
echo "==========================================================="
echo ""
echo "Next steps:"
echo "  doppler run -- terraform plan       # render TF with Doppler-secrets"
echo "  doppler run -- terraform apply"
echo "  doppler run -- npm test"
echo ""
