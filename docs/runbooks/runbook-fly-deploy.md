# Runbook — Fly.io Deploy + Operations

> **Audience**: solo-operator (Axel) on a private/hobby setup.
> **Plan-Ref**: [`deploy/fly/README.md`](../../deploy/fly/README.md), `fly.toml`, `fly.openbao.toml`.

This runbook complements `deploy/fly/README.md` (which is the step-by-step quickstart). Here we cover the gnarly stuff: troubleshooting, rotation, scale-up triggers, disaster recovery.

## Quick links

| Goal | Section |
|---|---|
| First deploy | [`deploy/fly/README.md`](../../deploy/fly/README.md) — use that, don't paraphrase here |
| Tail logs | [`§ Logs`](#logs) |
| Roll back a bad deploy | [`§ Rollback`](#rollback) |
| Rotate a secret | [`§ Secret rotation`](#secret-rotation) |
| Scale up (more traffic) | [`§ Scaling`](#scaling) |
| Vault sealed after restart | [`§ Unseal OpenBao`](#unseal-openbao) |
| DB restore from backup | [`§ Postgres restore`](#postgres-restore) |
| Lost volume / Vault disaster | [`§ Vault disaster`](#vault-disaster) |

## Logs

```bash
fly logs -a mcp-approval2                       # live tail (Ctrl-C to exit)
fly logs -a mcp-approval2 --since 1h            # last hour
fly logs -a mcp-approval2-openbao               # Vault logs (JSON)
fly logs -a mcp-approval2-pg                    # Postgres logs
```

If logs are empty: machines may be auto-stopped (free-tier `auto_stop_machines = "stop"`). Hit the URL once, then re-tail.

## Rollback

```bash
fly releases list -a mcp-approval2              # find <version>
fly releases rollback <version> -a mcp-approval2
```

Releases keep their secret snapshot, so rolling back also reverts secret changes that were bundled into that deploy. If you set new secrets *between* the bad deploy and the rollback, re-set them after.

**Health-check guard**: the Fly deploy strategy is `rolling` — a new machine must pass `/health` before the old one is shut down. If `/health` returns 5xx, the deploy aborts and the old machine stays. Inspect with `fly status -a mcp-approval2`.

## Secret rotation

```bash
# Generate a new bearer + push (triggers redeploy with zero-downtime rolling):
NEW=$(openssl rand -hex 32)
fly secrets set MCP_BEARER_TOKEN="$NEW" -a mcp-approval2

# Stage multiple at once, deploy explicitly:
fly secrets set --stage A=1 B=2 -a mcp-approval2
fly deploy --config fly.toml --remote-only

# Unset (deletes secret + redeploys):
fly secrets unset OLD_KEY -a mcp-approval2
```

### JWT keypair rotation (RS256)

The `JWT_KID` env carries the current key id. To rotate:

1. Generate a new keypair locally, give it a new kid (e.g. `key-20260601`).
2. **Publish both** in the JWKS document for ≥ JWKS-cache-TTL (mcp-knowledge2 caches 86400 s by default). The app already supports a single active key; for true dual-publish you need a brief code-level extension to expose both via JWKS.
3. After TTL expiry, drop the old key, bump `JWT_KID`, push:
   ```bash
   fly secrets set --app mcp-approval2 \
     JWT_RS256_PRIVATE_KEY_PEM="$(cat new-priv.pem)" \
     JWT_RS256_PUBLIC_KEY_PEM="$(cat new-pub.pem)" \
     JWT_KID="key-20260601"
   ```
4. Shred local key files (`shred -u …`).

## Scaling

| Symptom | Action |
|---|---|
| `/health` slow on cold-start | `fly scale count 1 --app mcp-approval2` (keeps one warm) — cost: ~2 €/month |
| CPU sustained > 80 % | `fly scale vm shared-cpu-2x --memory 1024 -a mcp-approval2` |
| Postgres slow | `fly scale vm dedicated-cpu-1x -a mcp-approval2-pg` (~28 €/month — only when needed) |
| Bandwidth ≫ 160 GB/month | bills 0.02 $/GB; mostly free for hobby |
| Cross-region latency | edit `primary_region` and re-deploy, or add machines via `fly scale count 2 --region ams,fra` |

## Unseal OpenBao

OpenBao seals itself on every machine restart. You need 2 of the 3 unseal keys + root token (saved out-of-band during `deploy.sh` step 6).

```bash
fly ssh console -a mcp-approval2-openbao
# inside container:
bao status                              # sealed=true?
bao operator unseal <key-1>
bao operator unseal <key-2>             # threshold reached
bao status                              # sealed=false, ready
exit
```

Until Vault is unsealed, `mcp-approval2` returns 503 for any request that touches a DEK-wrapped credential. The `/health` endpoint stays green (it doesn't touch Vault).

**Auto-unseal**: not configured for the hobby setup (cloud-KMS would defeat the cost target). Document each restart event in your private journal.

## Postgres restore (Neon)

Postgres-Backend ist Neon (seit 2026-05-17, vorher kurz Fly Postgres geplant). Neon hält ein 6h Point-in-Time-Restore-Window auf Free Tier, 7d auf Launch.

**Restore-Pfad (Neon-Console):**
1. Neon-Dashboard → Project `mcp-approval2` → Branches → "Create branch from a point in time"
2. Source = `main`, Timestamp = gewünschter Punkt (max 6h zurück auf Free Tier)
3. Neon legt einen neuen Branch + Endpoint an, Hostname `ep-<new-name>.c-3.eu-central-1.aws.neon.tech`
4. Neue Connection-Strings aus dem Neon-Dashboard kopieren oder via `neon` CLI:
   ```bash
   neon connection-string --project-id $(bash scripts/doppler-run-terraform.sh -chdir=terraform/environments/privat output -raw approval2_neon_project_id) --branch <new-branch-name>
   ```
5. `DATABASE_URL` + `DATABASE_ADMIN_URL` in Doppler updaten (`doppler secrets set DATABASE_URL=...`), Fly-App pickt sie beim nächsten Sync auf
6. Smoke `/health/ready` — wenn grün, alten Branch in Neon-Console löschen (oder weiter behalten falls Diff-Vergleich nötig)

**Cold-Backup-Fallback** (außerhalb des PITR-Windows):
```bash
export ADMIN_URL=$(doppler secrets get DATABASE_ADMIN_URL --plain --project mcp-approval2 --config fly)
pg_dump "$ADMIN_URL" > /external/disk/mcp-approval2-$(date +%Y%m%d).sql
unset ADMIN_URL
```
Quartalsweise auf externe SSD im Schrank — das ist die echte 3-2-1-Air-Gap-Schicht (siehe privat.md §9.2).

**Test-restore drill**: einmal pro Quartal. Branch-from-time gegen Test-Timestamp anlegen, `DATABASE_URL` umstellen, `/health` grün + bekannten Row readable.

## Vault disaster

If `vault_data` volume is lost (Fly outage, fat-finger `fly volumes destroy`):

1. Every column encrypted under a DEK-wrapped-by-KEK becomes unreadable: OAuth-refresh-tokens, Gateway-OAuth-tokens, anything in `credentials`.
2. The Postgres data is intact — re-bootstrapping Vault doesn't fix the existing ciphertext (KEK is gone).
3. Mitigation BEFORE disaster: snapshot the volume monthly.
   ```bash
   fly volumes list -a mcp-approval2-openbao
   fly volumes snapshots create <volume-id> -a mcp-approval2-openbao
   fly volumes snapshots list -a mcp-approval2-openbao
   ```
4. Recovery: create a fresh `vault_data` volume from a snapshot.
   ```bash
   fly volumes create vault_data --snapshot-id <id> --region fra -a mcp-approval2-openbao
   fly machines update --volume vault_data:/vault/data -a mcp-approval2-openbao
   fly ssh console -a mcp-approval2-openbao
   bao operator unseal …   # with the original 2 keys
   ```
5. If no snapshot exists: rotate every credential out-of-band, then nuke + re-bootstrap.

## Custom domain (optional)

```bash
fly certs add mcp.example.org -a mcp-approval2
# Add a CNAME at your DNS provider pointing to mcp-approval2.fly.dev
fly certs check mcp.example.org -a mcp-approval2
```

Then update env vars to match the new origin:

```bash
fly secrets set \
  BASE_URL="https://mcp.example.org" \
  WEBAUTHN_RP_ID="mcp.example.org" \
  WEBAUTHN_ORIGINS="https://mcp.example.org" \
  -a mcp-approval2
```

(WebAuthn passkeys are bound to `WEBAUTHN_RP_ID` — changing it invalidates existing credentials. Users must re-register a passkey.)

## Cost monitoring

```bash
fly orgs show personal      # shows current month's spend
```

Hard cap: set up a Fly-billing alert in the dashboard (Account → Billing → Alerts).

## Known limitations of the hobby setup

1. **Single region** — Fly App `fra` + Neon `eu-central-1` (Frankfurt). Cross-Atlantic-Latency wenn Machines in andere Regions skaliert werden, weil Neon-Endpoint regional ist.
2. **Single-node OpenBao** — file-backend, not Raft-HA. If the machine vanishes between snapshots, you lose key material. Snapshots are the only safety net.
3. **No DLQ for cron jobs** — the existing apps/server cron framework retries in-process. If a cron throws repeatedly, you'll only see it in logs.
4. **No structured cost alerts** — Fly bills monthly in arrears; check `fly orgs show personal` weekly.
