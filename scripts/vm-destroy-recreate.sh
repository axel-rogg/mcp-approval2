#!/usr/bin/env bash
# vm-destroy-recreate.sh — destroy + re-provision the Hetzner pilot VM.
#
# Bundle der 17 Schritte aus runbook-vm-destroy-recreate.md in einem
# resumebaren Skript. Idempotent: jeder Step macht state-check vor dem
# eigentlichen Befehl, du kannst das Skript bei Abbruch neu anstossen.
#
# DESTRUKTIV: terraform destroy entfernt Hetzner-VM + Docker-Volumes +
# DNS-Records. Vault-Root-Token + 3 Unseal-Keys werden NEU generiert.
# Nicht laufen lassen wenn User-Daten in der Postgres-DB sind ohne
# vorheriges Backup (backup.sh laeuft als monatlicher Cron auf R2).
#
# Voraussetzungen:
#   - lokales devcontainer-Setup mit Doppler-CLI + Terraform + SSH-Key
#   - .dev.vars enthaelt DOPPLER_TOKEN
#   - SSH-Config-Eintrag fuer mcp-approval2-vm (im Runbook beschrieben)
#
# Usage:
#   bash scripts/vm-destroy-recreate.sh           # interaktiv (default)
#   bash scripts/vm-destroy-recreate.sh --yes     # non-interactive
#   bash scripts/vm-destroy-recreate.sh --resume  # ueberspringe destroy+apply,
#                                                 # nur Konfig-Schritte
#
# Exit-Codes:
#   0 = Smoke gruen
#   1 = Pre-flight failed (kein Doppler-Token, etc.)
#   2 = terraform destroy/apply failed
#   3 = VM unerreichbar nach apply
#   4 = Container-Boot failed
#   5 = Smoke nicht gruen

set -euo pipefail

# ── Konfiguration ──────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TF_DIR="$REPO_ROOT/terraform/environments/privat"
HCLOUD_MODULE="$REPO_ROOT/terraform/modules/hetzner-mcp-instance/main.tf"
SSH_ALIAS="mcp-approval2-vm"
SSH_KEY="${HOME}/.ssh/mcp-approval2-operator"
LOG_FILE="$REPO_ROOT/.vm-destroy-recreate.log"
INIT_BACKUP_DIR="$REPO_ROOT/.vault-init-backups"

# Flags
INTERACTIVE=1
RESUME=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) INTERACTIVE=0; shift ;;
    --resume) RESUME=1; shift ;;
    --help|-h)
      sed -n '3,30p' "$0"
      exit 0
      ;;
    *) echo "ERR: unknown flag: $1" >&2; exit 1 ;;
  esac
done

# Helper: log + echo
log() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$LOG_FILE"; }
die() { log "ERR: $*"; exit "${2:-1}"; }

# ── Pre-flight ─────────────────────────────────────────────────────────
log "════════════════════════════════════════════════════════════════"
log "  VM destroy + re-provision  (log: $LOG_FILE)"
log "════════════════════════════════════════════════════════════════"

[[ -f "$REPO_ROOT/.dev.vars" ]] || die ".dev.vars nicht in $REPO_ROOT — DOPPLER_TOKEN fehlt"
# shellcheck disable=SC1091
set -a; source "$REPO_ROOT/.dev.vars"; set +a
[[ -n "${DOPPLER_TOKEN:-}" ]] || die "DOPPLER_TOKEN nicht in .dev.vars"

command -v terraform >/dev/null || die "terraform fehlt"
command -v doppler   >/dev/null || die "doppler-cli fehlt"
command -v jq        >/dev/null || die "jq fehlt"
command -v ssh       >/dev/null || die "ssh fehlt"
[[ -f "$SSH_KEY" ]] || die "SSH-Key nicht in $SSH_KEY (Erst-Setup ueber runbook-hetzner-deploy.md)"

HCLOUD_TOKEN=$(doppler secrets get HCLOUD_TOKEN --plain -p mcp-approval2 -c privat)
export HCLOUD_TOKEN
[[ -n "$HCLOUD_TOKEN" ]] || die "HCLOUD_TOKEN nicht in Doppler"

mkdir -p "$INIT_BACKUP_DIR"

# ── Safety-Check + Konfirmation ────────────────────────────────────────
if [[ $RESUME -eq 0 ]]; then
  log ""
  log "DAS FOLGENDE WIRD ZERSTOERT:"
  log "  - Hetzner-VM (id 130957874, ipv4 178.105.120.198)"
  log "  - Docker-Volumes: hetzner_pgdata, hetzner_vault-data, hetzner_caddy-*"
  log "  - Vault Root-Token + 3 Unseal-Keys (NEU generiert nach apply!)"
  log "  - Caddy Let's Encrypt Certs (neu via ACME, 1-3 min)"
  log ""
  log "BLEIBT erhalten:"
  log "  - Doppler-Secrets, Cloudflare-DNS-Eintraege (mit neuer IP),"
  log "    GitHub-Repo + Settings, Terraform-State"
  log ""

  if [[ $INTERACTIVE -eq 1 ]]; then
    read -rp "Sicher? Tippe 'DESTROY' zum Fortfahren: " confirm
    [[ "$confirm" == "DESTROY" ]] || die "Abgebrochen."
  fi

  # ─── Step 1: prevent_destroy auskommentieren ─────────────────────────
  log ""
  log "[1/17] prevent_destroy auskommentieren in $HCLOUD_MODULE"
  if grep -q '^    prevent_destroy = true$' "$HCLOUD_MODULE"; then
    sed -i 's/^    prevent_destroy = true$/    # prevent_destroy = true  # disabled by vm-destroy-recreate.sh/' "$HCLOUD_MODULE"
  else
    log "  (schon auskommentiert oder Pattern nicht da — verifizier manuell)"
  fi

  # ─── Step 2: terraform destroy (TARGETED — nur VM + DNS) ─────────────
  # Untargetes `destroy` wuerde auch das Doppler-Project + alle 33 Secret-
  # Placeholders sowie die GitHub-Repo-Settings (Branch-Protection,
  # Environments, etc.) loeschen. `prevent_destroy=true` greift nur auf
  # `github_repository.settings` und blockierte das partiell — aber die
  # Doppler-Secrets WAEREN WEG. Deshalb: explizit auf VM + DNS targeten.
  #
  # Was bleibt nach Step 2: module.doppler.*, module.github.* (inkl. Repo-
  # Settings, Branch-Protection, Doppler-Token-Sec rets), data.cloudflare_zone.
  log "[2/17] terraform destroy (targeted: module.vm + module.dns)"
  bash "$REPO_ROOT/scripts/doppler-run-terraform.sh" destroy \
    -target=module.vm -target=module.dns -auto-approve 2>&1 \
    | tee -a "$LOG_FILE" || die "terraform destroy failed" 2

  # ─── Step 3: prevent_destroy wieder einkommentieren ──────────────────
  log "[3/17] prevent_destroy wieder einkommentieren"
  sed -i 's/^    # prevent_destroy = true  # disabled by vm-destroy-recreate.sh$/    prevent_destroy = true/' "$HCLOUD_MODULE"

  # ─── Step 4: terraform apply (neue VM) ───────────────────────────────
  log "[4/17] terraform apply"
  bash "$REPO_ROOT/scripts/doppler-run-terraform.sh" apply -auto-approve 2>&1 | tee -a "$LOG_FILE" || die "terraform apply failed" 2

  # ─── Step 5: warten bis VM SSH-reachable ─────────────────────────────
  NEW_IPV4=$(cd "$TF_DIR" && bash "$REPO_ROOT/scripts/doppler-run-terraform.sh" output -raw vm_ipv4)
  log "[5/17] neue VM ipv4=$NEW_IPV4, warte auf SSH..."
  for i in {1..30}; do
    if ssh -i "$SSH_KEY" -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new \
         -o UserKnownHostsFile=/dev/null deploy@"$NEW_IPV4" 'echo ready' 2>/dev/null | grep -q '^ready$'; then
      log "  SSH ready nach ${i}*5s"
      break
    fi
    sleep 5
    [[ $i -eq 30 ]] && die "SSH-timeout nach 150s" 3
  done

  # SSH-config falls IP gewechselt hat (Hetzner gibt meist gleiche, aber
  # nicht garantiert)
  if ! grep -q "^  HostName $NEW_IPV4$" "$HOME/.ssh/config" 2>/dev/null; then
    log "  Update ~/.ssh/config (mcp-approval2-vm -> $NEW_IPV4)"
    sed -i "/^Host $SSH_ALIAS/,/^$/s/^  HostName .*/  HostName $NEW_IPV4/" "$HOME/.ssh/config" || true
  fi
fi  # end of destroy-and-apply block (resume skipped these)

# ─── Step 6: docker-compose-plugin auf VM installieren (cloud-init race fix) ─
log "[6/17] docker-compose-plugin installieren"
ssh "$SSH_ALIAS" 'command -v docker compose >/dev/null 2>&1 && docker compose version 2>&1 | head -1' \
  | grep -q "Compose version" \
  || ssh "$SSH_ALIAS" '
    sudo install -m 0755 -d /etc/apt/keyrings &&
    sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc &&
    sudo chmod a+r /etc/apt/keyrings/docker.asc &&
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
      | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null &&
    sudo apt-get update -qq &&
    sudo apt-get install -y docker-compose-plugin gettext-base jq
  ' 2>&1 | tee -a "$LOG_FILE"

# ─── Step 7: Doppler-CLI auf VM installieren ─────────────────────────
log "[7/17] doppler-cli auf VM installieren"
ssh "$SSH_ALIAS" 'command -v doppler >/dev/null 2>&1' \
  || ssh "$SSH_ALIAS" 'curl -Ls --tlsv1.2 --proto "=https" --retry 3 https://cli.doppler.com/install.sh | sudo sh' \
       2>&1 | tee -a "$LOG_FILE"

# ─── Step 8: Doppler-VM-Token deployen ────────────────────────────────
log "[8/17] Doppler-VM-Token nach /opt/mcp-approval2/.doppler-token"
VM_TOKEN=$(cd "$TF_DIR" && bash "$REPO_ROOT/scripts/doppler-run-terraform.sh" output -raw doppler_vm_token)
ssh "$SSH_ALIAS" "echo '$VM_TOKEN' | sudo tee /opt/mcp-approval2/.doppler-token >/dev/null && sudo chown deploy:deploy /opt/mcp-approval2/.doppler-token && sudo chmod 600 /opt/mcp-approval2/.doppler-token"

# ─── Step 9: doppler-vm-sync.sh (rendert .env) ───────────────────────
log "[9/17] doppler-vm-sync.sh laufen lassen"
ssh "$SSH_ALIAS" 'bash /opt/mcp-approval2/scripts/doppler-vm-sync.sh' 2>&1 | tee -a "$LOG_FILE"

# ─── Step 10: render-config.sh (Caddyfile) ───────────────────────────
log "[10/17] Caddyfile rendern"
ssh "$SSH_ALIAS" '
  cd /opt/mcp-approval2/deploy/hetzner
  sudo rm -rf Caddyfile  # falls Docker einen Dir angelegt hat
  bash render-config.sh
' 2>&1 | tee -a "$LOG_FILE"

# ─── Step 11: mcp-approval2 Image lokal bauen (GHCR ist private) ─────
log "[11/17] mcp-approval2 Image lokal bauen (kann 5-10 min dauern)"
ssh "$SSH_ALIAS" '
  cd /opt/mcp-approval2 &&
  sudo docker build -t ghcr.io/axel-rogg/mcp-approval2:latest -f deploy/fly/Dockerfile.server .
' 2>&1 | tee -a "$LOG_FILE" | tail -10

# ─── Step 12: postgres + openbao starten ─────────────────────────────
log "[12/17] postgres + openbao starten"
ssh "$SSH_ALIAS" '
  cd /opt/mcp-approval2/deploy/hetzner
  sudo docker compose --env-file .env up -d postgres openbao
' 2>&1 | tee -a "$LOG_FILE"

# auf postgres healthy warten
log "  warte auf postgres healthy..."
for i in {1..30}; do
  if ssh "$SSH_ALIAS" 'sudo docker compose -f /opt/mcp-approval2/deploy/hetzner/docker-compose.yml --env-file /opt/mcp-approval2/deploy/hetzner/.env ps postgres' 2>/dev/null | grep -q "healthy"; then
    log "  postgres healthy nach ${i}*3s"
    break
  fi
  sleep 3
done

# ─── Step 13: vault-init.sh (NEUE Keys, NEUER Root-Token) ────────────
log "[13/17] vault-init.sh — NEUE Unseal-Keys + Root-Token werden generiert"
TS=$(date -u +%Y%m%dT%H%M%SZ)
VAULT_INIT_LOG="$INIT_BACKUP_DIR/vault-init-$TS.log"
ssh "$SSH_ALIAS" 'cd /opt/mcp-approval2/deploy/hetzner && sudo bash vault-init.sh' 2>&1 \
  | tee "$VAULT_INIT_LOG" | tee -a "$LOG_FILE"

# Root-Token extrahieren (vault-init.sh schreibt .vault-init-output-<ts>.json
# auf die VM; wir holen den Inhalt lokal in's backup-Verzeichnis)
ssh "$SSH_ALIAS" 'sudo cat /opt/mcp-approval2/.vault-init-output-*.json | tail -1' \
  > "$INIT_BACKUP_DIR/vault-init-$TS.json" 2>/dev/null || true
chmod 600 "$INIT_BACKUP_DIR/vault-init-$TS.json"
ROOT_TOKEN=$(jq -r '.root_token' < "$INIT_BACKUP_DIR/vault-init-$TS.json" 2>/dev/null || echo "")
[[ -n "$ROOT_TOKEN" ]] || die "konnte Vault-Root-Token nicht extrahieren — manuell von VM holen" 4

log "  ⚠  NEUE Vault-Init-Outputs liegen in $INIT_BACKUP_DIR/vault-init-$TS.{log,json}"
log "  ⚠  BACK UP OFFLINE NOW (Paper-Wallet oder verschluesselter USB)."

# ─── Step 14: VAULT_TOKEN in Doppler stempeln ────────────────────────
log "[14/17] VAULT_TOKEN in Doppler stempeln"
doppler secrets set "VAULT_TOKEN=$ROOT_TOKEN" -p mcp-approval2 -c privat --silent

# ─── Step 15: doppler-vm-sync.sh nochmal (mit neuem VAULT_TOKEN) ─────
log "[15/17] .env nochmal syncen (jetzt mit VAULT_TOKEN)"
ssh "$SSH_ALIAS" 'bash /opt/mcp-approval2/scripts/doppler-vm-sync.sh' 2>&1 | tail -3 | tee -a "$LOG_FILE"

# ─── Step 16: alle Services starten + Migrations ─────────────────────
log "[16/17] docker compose up -d (alle Services) + Migrations"
ssh "$SSH_ALIAS" '
  cd /opt/mcp-approval2/deploy/hetzner
  sudo docker compose --env-file .env up -d mcp-approval2 caddy
  # Migrations laufen automatisch via Container-Boot? Nein — explizit:
  sleep 5
  sudo docker compose --env-file .env exec -T mcp-approval2 npx tsx scripts/migrate.ts
' 2>&1 | tee -a "$LOG_FILE"

# ─── Step 17: Smoke ───────────────────────────────────────────────────
log "[17/17] Smoke (wartet ggf. 1-3 min auf Lets-Encrypt-Cert)"
SMOKE_OK=0
for i in {1..36}; do
  if curl -sIfm 10 https://mcp2.ai-toolhub.org/health 2>/dev/null | grep -q "^HTTP/2 200"; then
    SMOKE_OK=1
    log "  mcp2.ai-toolhub.org/health -> 200 nach ${i}*5s"
    break
  fi
  sleep 5
done
[[ $SMOKE_OK -eq 1 ]] || die "Smoke nicht gruen nach 180s" 5

curl -sIm 10 https://app2.ai-toolhub.org/ 2>&1 | head -1 | tee -a "$LOG_FILE"
curl -sIm 10 https://static.198.120.105.178.clients.your-server.de/health 2>&1 | head -1 | tee -a "$LOG_FILE"

log ""
log "════════════════════════════════════════════════════════════════"
log "  DONE. Stack live, Smoke gruen."
log "  Vault-Init-Backup: $INIT_BACKUP_DIR/vault-init-$TS.{log,json}"
log "  Volle Log-Datei:   $LOG_FILE"
log "════════════════════════════════════════════════════════════════"
