# Hetzner Deploy — mcp-approval2 + mcp-knowledge2

Single Hetzner CX21 VM running both services + Postgres + OpenBao + Caddy
in one docker-compose stack. See
[`docs/plans/active/PLAN-hetzner-deployment.md`](../../docs/plans/active/PLAN-hetzner-deployment.md)
for the full architecture and rationale.

## What's here

| File | Purpose |
|---|---|
| `docker-compose.yml` | 5-service stack (caddy, postgres, openbao, mcp-approval2, mcp-knowledge2) |
| `docker-compose.override.example.yml` | Local-dev port exposures + log levels |
| `.env.example` | Catalogue of every env var consumed by Compose |
| `Caddyfile.tpl` | Reverse-proxy template with `${DOMAIN_*}` substitution |
| `cloud-init.yaml.tpl` | VM bootstrap (consumed by Terraform) |
| `postgres-init.sql` | Creates `knowledge2` DB + pgvector/pgcrypto extensions |
| `generate-secrets.sh` | Emits a fresh `.env` to stdout (RS256 keys + tokens) |
| `vault-init.sh` | Initialises OpenBao + transit engine + AppRole |
| `render-config.sh` | `*.tpl` → real files via `envsubst` |
| `setup.sh` | First-time deploy orchestrator |
| `update.sh` | Pulls latest code/images, restarts, migrates |
| `backup.sh` | Nightly DB dump + Vault snapshot → Storage Box (optional) |
| `restore.sh` | Restore from a backup directory |
| `healthcheck.sh` | Status snapshot, exit non-zero on any red |
| `watchtower-notifications.md` | Notification-Setups (Slack, Discord, Email, webhook) |

## Prerequisites

1. **VM exists.** Hetzner Cloud CX21 (or larger), Ubuntu 24.04, provisioned
   by [`terraform/environments/privat/`](../../terraform/environments/privat/)
   with the `cloud-init.yaml.tpl` rendered.
2. **DNS records exist.** `mcp2.ai-toolhub.org`, `knowledge2.ai-toolhub.org`,
   `app2.ai-toolhub.org` all point to the VM's IPv4/IPv6. (Also managed by
   Terraform via the Cloudflare provider.)
3. **Google OAuth client exists.** Create at
   <https://console.cloud.google.com/apis/credentials> with the redirect URI
   `https://mcp2.ai-toolhub.org/oauth/google/callback`.
4. **Optional: Vertex-AI service-account JSON.** Drop into
   `deploy/hetzner/secrets/vertex-sa.json` (chmod 600). Skip if you don't
   need AI features.

## First-time deploy

```bash
# 1. SSH to the VM as the deploy user (cloud-init pre-creates it)
ssh deploy@<VM_IP>

cd /opt/mcp-approval2/deploy/hetzner

# 2. Generate machine secrets to .env
bash generate-secrets.sh > .env

# 3. Fill in human-supplied values:
#      - GOOGLE_OAUTH_CLIENT_ID + SECRET
#      - VERTEX_AI_PROJECT_ID (optional)
#      - DOMAIN_* if you don't use the Phase-A defaults
nano .env

# 4. (Optional) Drop the Vertex SA JSON
mkdir -p secrets
nano secrets/vertex-sa.json   # paste the service-account JSON
chmod 600 secrets/vertex-sa.json

# 5. Bring up the stack — this also runs vault-init + migrations
bash setup.sh

# 6. Verify
bash healthcheck.sh
```

After `setup.sh` finishes, the script prints the VAULT_TOKEN you need to
paste back into `.env`, then run:

```bash
docker compose up -d --force-recreate mcp-approval2
```

so the app picks up the freshly minted token.

## Day-2 operations

### Update

```bash
ssh deploy@<VM_IP>
cd /opt/mcp-approval2/deploy/hetzner
bash update.sh
```

`update.sh` pulls the repo, pulls images, restarts containers, runs
migrations, reloads Caddy (zero-downtime), and runs the healthcheck.

## Auto-Updates via Watchtower

Watchtower polled ghcr.io alle 5 min und pulled neue Image-Tags
automatisch. Überwacht nur **mcp-approval2** + **mcp-knowledge2** (NICHT
Postgres/OpenBao/Caddy — die musst du manuell mit `bash update.sh`
aktualisieren). Watchtower selbst ist ebenfalls aus dem Auto-Update
ausgenommen (rekursiv-gefährlich).

### Wie es funktioniert

1. CI baut neues Image bei `push` to `main` → `ghcr.io/axel-rogg/mcp-approval2:latest`
2. Watchtower checkt Image-Digest alle 5 min (`WATCHTOWER_POLL_INTERVAL`)
3. Wenn neuer Digest: stoppt alten Container, pulled neuen, startet ihn
   (mit gleichen env + volumes + network)
4. Rolling-Restart (`WATCHTOWER_ROLLING_RESTART=true`): nicht beide
   gleichzeitig, sondern nacheinander
5. Alte Images werden aufgeräumt (`WATCHTOWER_CLEANUP=true`)

Watchtower entscheidet anhand des Image-Digests, nicht des Tag-Strings →
robuster für `latest`-Floating-Tags.

### Auto-Update aktivieren / deaktivieren

Per Container-Label (im `docker-compose.yml`):
```yaml
services:
  mcp-approval2:
    labels:
      com.centurylinklabs.watchtower.enable: "true"   # in / out
```

Auf einem laufenden Container ad hoc:
```bash
# Aktivieren
docker label add <container_name> com.centurylinklabs.watchtower.enable=true

# Deaktivieren (sofort)
docker label add <container_name> com.centurylinklabs.watchtower.enable=false
```

### Notifications (optional)

Watchtower kann nach jedem Update-Event eine Notification schicken
(Slack, Discord, Email, generic Webhook).

Setup in `.env`:
```bash
WATCHTOWER_NOTIFICATIONS=shoutrrr
WATCHTOWER_NOTIFICATION_URL=slack://<bot_token>@<channel_id>
WATCHTOWER_NOTIFICATIONS_LEVEL=info
```

Beispiele für Slack/Discord/Email/Webhook stehen in
[`watchtower-notifications.md`](watchtower-notifications.md).

### Watchtower-Logs einsehen

```bash
docker compose logs -f watchtower
```

Erwartete Log-Patterns:
- `Checking for updates`
- `Found new <image>:<tag> signature`
- `Pulling <image>`
- `Stopping <container>` → `Starting <container>`
- `Session done` (mit Counter `Scanned/Updated/Failed`)

### Disable kurzfristig (z.B. während Migration)

```bash
docker compose pause watchtower

# Nach Migration:
docker compose unpause watchtower
```

Alternativ den Service komplett ausschalten:
```bash
docker compose stop watchtower
# … später:
docker compose start watchtower
```

### Image-Tag-Strategy

- `latest` → Watchtower pulled bei jedem Image-Digest-Change (Default für
  prod).
- `vX.Y.Z` (semver) → Watchtower folgt NICHT zwischen Tags; pulled nur
  bei einem Re-Push desselben Tags mit anderem Digest. Pinning sinnvoll
  für canary / staging.
- Empfehlung: production-VM nutzt `TAG=latest` + `KNOWLEDGE_TAG=latest`,
  dev-VM kann auf einen spezifischen Tag pinnen.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Watchtower pulled nicht | Label fehlt | `docker inspect <container> | grep watchtower` |
| `unauthorized: authentication required` in Logs | `GHCR_TOKEN` leer / abgelaufen | Neuen PAT mit `read:packages` erzeugen, in `.env` setzen, `docker compose up -d watchtower` |
| Container restartet ständig | Neues Image bricht den Start | `WATCHTOWER_POLL_INTERVAL` hochsetzen, manuell auf stabilen Tag pinnen |
| Watchtower sieht Updates, restartet aber nicht | Container hat label `enable=false` oder Watchtower hat `WATCHTOWER_LABEL_ENABLE=true` und Label fehlt | Labels in `docker-compose.yml` prüfen |

### Backup (cron)

```bash
sudo crontab -e
# 0 3 * * * /opt/mcp-approval2/deploy/hetzner/backup.sh >> /var/log/mcp-backup.log 2>&1
```

Backups land in `./backups/<YYYY-MM-DD>/` with a 7-day local retention. If
you set `STORAGE_BOX_HOST` + `STORAGE_BOX_USER` (e.g. in
`/etc/default/mcp-backup`), the script also rsyncs to a Hetzner Storage
Box.

### Restore

```bash
bash restore.sh ./backups/2026-05-13
```

Type `YES, RESTORE` when prompted. The script will:
1. verify checksums (if `MANIFEST.txt` is present),
2. stop the app containers,
3. drop+recreate both DBs from the dumps,
4. swap the Vault data over the existing volume,
5. restart the stack and run the healthcheck.

You'll need to re-unseal Vault with the original unseal keys (kept in the
offline backup of `.vault-init-output-*.json`).

### Healthcheck (anytime)

```bash
bash healthcheck.sh
```

Exits `0` on all green, `1` on any failure. Useful for monitoring hooks.

## Local development

```bash
cp docker-compose.override.example.yml docker-compose.override.yml
docker compose up -d
```

The override exposes Postgres (5432), OpenBao (8200), mcp-approval2 (8787)
and mcp-knowledge2 (8788) on localhost so you can run vitest / curl /
psql directly against them.

## Security notes

- `.env` is gitignored. Never commit it.
- `.vault-init-output-*.json` is created by `vault-init.sh` and contains
  the unseal keys + root token. Move it to offline storage immediately and
  remove it from the VM.
- `secrets/vertex-sa.json` is gitignored and bind-mounted read-only into
  the mcp-approval2 container.
- Caddy auto-provisions Let's Encrypt certs at first request — the
  `ACME_EMAIL` from `.env` is used for expiry notifications.
- UFW (set up by `cloud-init.yaml.tpl`) only allows 22/80/443. Postgres
  and OpenBao are docker-network-only.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `healthcheck.sh` says caddy → 000 | DNS not propagated yet | Wait, then `dig +short ${DOMAIN_MCP}` |
| Caddy logs `no certificate available` | Let's Encrypt rate-limited or DNS wrong | Check `docker compose logs caddy`; verify A record |
| `mcp-approval2 /health` 500 | `VAULT_TOKEN` wrong | Re-run `vault-init.sh`, update `.env`, recreate container |
| `pg_isready` fails after restore | Long-running query held lock | `docker compose restart postgres` and re-run |
| Postgres OOM-kills on CX21 | Container needs swap | `cloud-init.yaml.tpl` provisions 2 GB; verify `swapon --show` |
