#!/usr/bin/env bash
# vm-destroy-only.sh — destroy ONLY (kein anschliessendes recreate).
#
# Im Gegensatz zu vm-destroy-recreate.sh laesst dieses Skript die VM
# nach dem Destroy WEG. Anschluss-Restart spaeter via
# `vm-destroy-recreate.sh --resume` (skipped destroy+apply) ist nicht
# direkt anwendbar — das `--resume`-Flag erwartet eine existierende VM.
# Stattdessen: spaeter manuell `terraform apply` + dann Steps 6-17 aus
# dem Recreate-Skript laufen lassen (oder dafuer ein separates
# `vm-recreate-only.sh` schreiben — TODO).
#
# DESTRUKTIV: entfernt Hetzner-VM + Docker-Volumes (pgdata, vault-data,
# caddy-data) + 6 Cloudflare-DNS-Records. NICHT angetastet:
# Doppler-Project + 33 Secrets, GitHub-Repo + Branch-Protection,
# Terraform-State.
#
# Usage:
#   bash scripts/vm-destroy-only.sh           # interaktiv
#   bash scripts/vm-destroy-only.sh --yes     # non-interactive
#
# Exit:  0 = destroyed, 1 = pre-flight, 2 = destroy failed, 3 = sed restore failed

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HCLOUD_MODULE="$REPO_ROOT/terraform/modules/hetzner-mcp-instance/main.tf"
LOG_FILE="$REPO_ROOT/.vm-destroy-only.log"

INTERACTIVE=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) INTERACTIVE=0; shift ;;
    --help|-h) sed -n '3,25p' "$0"; exit 0 ;;
    *) echo "ERR: unknown flag: $1" >&2; exit 1 ;;
  esac
done

log() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$LOG_FILE"; }
die() { log "ERR: $*"; exit "${2:-1}"; }

log "════════════════════════════════════════════════════════════════"
log "  VM destroy-only  (log: $LOG_FILE)"
log "════════════════════════════════════════════════════════════════"

# Pre-flight
[[ -f "$REPO_ROOT/.dev.vars" ]] || die ".dev.vars fehlt"
# shellcheck disable=SC1091
set -a; source "$REPO_ROOT/.dev.vars"; set +a
[[ -n "${DOPPLER_TOKEN:-}" ]] || die "DOPPLER_TOKEN fehlt"
command -v terraform >/dev/null || die "terraform fehlt"

# Konfirmation
if [[ $INTERACTIVE -eq 1 ]]; then
  log ""
  log "DAS WIRD ZERSTOERT (terraform destroy -target=module.vm -target=module.dns):"
  log "  - Hetzner-VM privat-mcp (id 130957874)"
  log "  - hcloud_ssh_key.operator + hcloud_firewall.mcp + firewall_attachment"
  log "  - 6 cloudflare_dns_record (mcp2/knowledge2/app2 A + AAAA)"
  log "  - Docker-Volumes auf der VM (pgdata, vault-data, caddy-data/config)"
  log ""
  log "BLEIBT erhalten:"
  log "  - Doppler-Project + alle 33 Secret-Werte"
  log "  - GitHub-Repo Settings + Branch-Protection + Action-Secrets"
  log "  - Cloudflare-Zone (nur die DNS-Records werden re-created bei naechstem apply)"
  log "  - Terraform-State (auf R2)"
  log ""
  read -rp "Sicher? Tippe 'DESTROY' zum Fortfahren: " confirm
  [[ "$confirm" == "DESTROY" ]] || die "Abgebrochen."
fi

# Step 1: prevent_destroy auskommentieren
log "[1/3] prevent_destroy auskommentieren"
sed -i 's/^    prevent_destroy = true$/    # prevent_destroy = true  # disabled-by-destroy-only/' "$HCLOUD_MODULE"
COUNT=$(grep -c "# prevent_destroy = true  # disabled-by-destroy-only" "$HCLOUD_MODULE" || true)
[[ "$COUNT" -eq 2 ]] || log "  WARN: erwartete 2 Treffer, fand $COUNT"

# Trap: bei Abbruch prevent_destroy wieder einkommentieren
restore_prevent_destroy() {
  log "Restore prevent_destroy (Trap)"
  sed -i 's/^    # prevent_destroy = true  # disabled-by-destroy-only$/    prevent_destroy = true/' "$HCLOUD_MODULE"
}
trap restore_prevent_destroy EXIT

# Step 2: targeted destroy
log "[2/3] terraform destroy -target=module.vm -target=module.dns"
bash "$REPO_ROOT/scripts/doppler-run-terraform.sh" destroy \
  -target=module.vm -target=module.dns -auto-approve 2>&1 \
  | tee -a "$LOG_FILE" || die "terraform destroy failed" 2

# Step 3: prevent_destroy wieder einkommentieren (auch via Trap, doppelt haelt)
log "[3/3] prevent_destroy wieder einkommentieren"
sed -i 's/^    # prevent_destroy = true  # disabled-by-destroy-only$/    prevent_destroy = true/' "$HCLOUD_MODULE"
trap - EXIT

# Verify state
log ""
log "Post-destroy state:"
bash "$REPO_ROOT/scripts/doppler-run-terraform.sh" state list 2>&1 \
  | grep -cE "module\.(vm|dns)\." | while read -r N; do
      log "  module.vm/dns Ressourcen im State: $N (erwartet 0)"
    done

log "════════════════════════════════════════════════════════════════"
log "  DONE. VM weg, Doppler+GitHub+TF-State intakt."
log "  Restart spaeter: terraform apply + Steps 6-17 aus vm-destroy-recreate.sh"
log "════════════════════════════════════════════════════════════════"
