# Runbook: VM Start / Stop / Re-Sync

> **Status:** Ready
> **Letzte Verifikation:** 2026-05-14
> **Estimated time:** 30-60s pro Start oder Stop

Operative Steuerung der Hetzner-VM `privat-mcp` zwischen Sessions ohne
`terraform destroy` zu brauchen. Die Doppler-/Cloudflare-/GitHub-Ressourcen
bleiben dabei unangetastet.

## Aktuelle VM-Identitaet

| Feld | Wert | Quelle |
|---|---|---|
| Server-Name | `privat-mcp` | terraform output |
| Server-ID | `130957874` | `hcloud server list` oder API |
| IPv4 | `178.105.120.198` | `terraform output -raw vm_ipv4` |
| IPv6 | `2a01:4f8:c015:3bf1::1` | `terraform output -raw vm_ipv6` |
| Default-FQDN (Coop-Bypass) | `static.198.120.105.178.clients.your-server.de` | `terraform output -raw default_hetzner_fqdn_v4` |
| Server-Type | `cpx22` (2c/4GB/80GB) | `terraform.tfvars`/Doppler |
| Location | `fsn1` (Frankfurt) | s.o. |

SSH-Aliase auf dem Operator-Host (Devcontainer):
```bash
# ~/.ssh/config
Host mcp-approval2-vm
  HostName 178.105.120.198
  User deploy
  IdentityFile ~/.ssh/mcp-approval2-operator
  StrictHostKeyChecking accept-new
  ServerAliveInterval 30
```

## VM-Powerstate steuern (via Hetzner-API)

`terraform destroy` ist durch `prevent_destroy=true` (siehe
[Audit-Findings #1, 2026-05-14](../plans/PLAN-mcp-knowledge2-v2-architecture.md))
blockiert. Power-Management laeuft daher direkt gegen die Hetzner-API.

```bash
# Token aus Doppler ziehen (nicht loggen)
cd /workspaces/mcp-approval2
set -a && source .dev.vars && set +a
HTOKEN=$(doppler secrets get HCLOUD_TOKEN --plain -p mcp-approval2 -c privat)
SERVER_ID=130957874
```

### Power-Off (graceful, ACPI-shutdown)
```bash
curl -sH "Authorization: Bearer $HTOKEN" \
  -X POST https://api.hetzner.cloud/v1/servers/$SERVER_ID/actions/shutdown \
  | jq -r '.action | "status=\(.status) progress=\(.progress)%"'

# Auf "off" warten (~5-15s)
until curl -sH "Authorization: Bearer $HTOKEN" \
    https://api.hetzner.cloud/v1/servers/$SERVER_ID \
    | jq -r '.server.status' | grep -q "^off$"; do
  sleep 3
done
echo "VM is off."
```

### Power-On
```bash
curl -sH "Authorization: Bearer $HTOKEN" \
  -X POST https://api.hetzner.cloud/v1/servers/$SERVER_ID/actions/poweron \
  | jq -r '.action | "status=\(.status)"'

# Auf "running" + SSH-reachable warten
until curl -sH "Authorization: Bearer $HTOKEN" \
    https://api.hetzner.cloud/v1/servers/$SERVER_ID \
    | jq -r '.server.status' | grep -q "^running$"; do
  sleep 3
done
until ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new \
    mcp-approval2-vm 'echo ready' 2>/dev/null | grep -q "^ready$"; do
  sleep 3
done
echo "VM is up + SSH reachable."
```

### Hard-Reset (nur im Notfall — kein graceful shutdown)
```bash
curl -sH "Authorization: Bearer $HTOKEN" \
  -X POST https://api.hetzner.cloud/v1/servers/$SERVER_ID/actions/reset
```

## Docker-Stack steuern

### Stack hochfahren (nach VM-Power-On)
```bash
ssh mcp-approval2-vm '
  cd /opt/mcp-approval2/deploy/hetzner
  # Doppler-Sync (falls Secrets in Doppler veraendert seit letztem Run)
  /opt/mcp-approval2/scripts/doppler-vm-sync.sh
  # Stack hoch
  sudo docker compose --env-file .env up -d
'
```

`docker-compose.yml` haelt depends-on-Health-Gating: postgres muss
healthy sein, bevor mcp-approval2 startet. Bei `up -d` blockt das
~10-20s.

### Vault-Unseal nach Power-On (Pflicht!)
OpenBao-Daten in `/vault/data` (Docker-Volume `hetzner_vault-data`)
bleiben persistent. Beim Container-Start ist Vault aber **sealed** und
muss manuell unsealed werden (2 von 3 Keys aus
`/opt/mcp-approval2/.vault-init-output.json`, chmod 600 auf der VM).

```bash
ssh mcp-approval2-vm '
  cd /opt/mcp-approval2
  KEY1=$(sudo jq -r ".unseal_keys_b64[0]" .vault-init-output.json)
  KEY2=$(sudo jq -r ".unseal_keys_b64[1]" .vault-init-output.json)
  sudo docker exec -e BAO_ADDR=http://127.0.0.1:8200 mcp-openbao \
    bao operator unseal "$KEY1" >/dev/null
  sudo docker exec -e BAO_ADDR=http://127.0.0.1:8200 mcp-openbao \
    bao operator unseal "$KEY2" 2>&1 | grep -E "Sealed|Initialized"
'
```

> **TODO:** Auto-Unseal-Daemon (systemd-Unit der nach Boot `unseal`
> macht). Aktuell manueller Schritt — bewusst, weil Single-User-Pilot
> keine Hot-Restore-Anforderung hat.

### Stack runterfahren (Volumes preserved)
```bash
ssh mcp-approval2-vm '
  cd /opt/mcp-approval2/deploy/hetzner
  sudo docker compose --env-file .env down
'
```

Volumes (`hetzner_pgdata`, `hetzner_vault-data`, `hetzner_caddy-*`)
bleiben unberuehrt — Re-Start ist <30s.

### Stack komplett zuruecksetzen (DESTRUKTIV!)
```bash
# NUR wenn du wirklich PG + Vault verlieren willst:
ssh mcp-approval2-vm '
  cd /opt/mcp-approval2/deploy/hetzner
  sudo docker compose --env-file .env down -v
  # Plus: .vault-init-output.json sichern oder loeschen, vault muss neu init
'
```

Folgekosten: vault-init nochmal laufen lassen, neuen Root-Token in
Doppler stempeln, PG-Migrations neu durchziehen, Apps neu seeden.

## Smoke nach Restart

```bash
# Vom Operator-Host
curl -sI https://mcp2.ai-toolhub.org/health  # API
curl -sI https://app2.ai-toolhub.org/        # PWA
curl -sI https://static.198.120.105.178.clients.your-server.de/health  # Coop-Bypass

# Container-Health auf VM
ssh mcp-approval2-vm 'sudo docker compose -f /opt/mcp-approval2/deploy/hetzner/docker-compose.yml --env-file /opt/mcp-approval2/deploy/hetzner/.env ps'
```

Erwartet: 3x HTTP/2 200, alle Container `Up (healthy)`.

## Doppler-Sync bei Secret-Rotation

Wenn ein Secret im Doppler-UI geaendert wird, muss die VM neu syncen:
```bash
ssh mcp-approval2-vm '
  /opt/mcp-approval2/scripts/doppler-vm-sync.sh
  cd /opt/mcp-approval2/deploy/hetzner
  sudo docker compose --env-file .env up -d --force-recreate mcp-approval2
'
```

`up -d` ist idempotent — re-creiert nur Container deren env-Hash sich
geaendert hat. `--force-recreate` zieht den Container egal was.

## Kosten-Erwartung

| Powerstate | Kosten ~/Tag | Anmerkung |
|---|---|---|
| `running` | ~30 Cent (€8.64/Mo cpx22) | Voll-Tarif |
| `off` (VM stopped) | ~15 Cent | Hetzner berechnet ~50% Disk-Reservierung |
| VM komplett geloescht | €0 | Aber Doppler-Re-Setup + neue IP + Re-Deploy |

Erwartet fuer aktive Entwicklungs-Phase: VM laeuft. Bei mehrtaegigen
Pausen lohnt sich `off`.

## Troubleshooting

- **SSH timeout nach Power-On**: VM braucht ~30s bis SSH wieder horcht.
  Erst nach `status=running` + `ssh ... echo ready` weitermachen.
- **`docker compose up` haengt bei "Waiting"**: postgres-healthcheck.
  `docker compose logs postgres` checken, normal nach ~15s gruen.
- **OpenBao sealed nach Restart**: erwartet — siehe Unseal-Schritt oben.
- **Caddy zeigt "no upstreams available"**: mcp-approval2 oder
  mcp-knowledge2 ist noch nicht healthy. Caddy macht active health-check
  alle 30s, wartet automatisch.
- **TLS-Cert-Errors**: nicht erwartet — Caddy hat Cert bereits in
  `hetzner_caddy-data` cached.

## Referenzen

- [runbook-hetzner-deploy.md](runbook-hetzner-deploy.md) — Initial-Deploy
- [runbook-hetzner-rotate-vault.md](runbook-hetzner-rotate-vault.md) — Token-Rotation
- [runbook-doppler.md](runbook-doppler.md) — Secret-Management
- [docs/STATUS.md](../STATUS.md) — Snapshot aktueller Stand
