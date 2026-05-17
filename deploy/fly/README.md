# Fly.io Deployment — mcp-approval2

> **Status (2026-05-17):** primärer Deploy-Pfad für privat-Mode.
> Architektur-Wahrheit: [docs/privat.md](../../docs/privat.md) (Fly.io-Switch vom
> Hetzner-Self-Host wegen Operations-Last-Realismus bei Solo-Operator).
> GCP-business-Mode-Pfad bleibt vollständig erhalten via Adapter-Factory-Pattern
> + Provider-Switch-Matrix in privat.md §5.

Private/family deploy of `mcp-approval2` on Fly.io für **2-5 User**. Target footprint: **~5–10 €/month**.

## Architecture (3 Fly resources)

| Resource | Type | Region | Cost (est) | Purpose |
|---|---|---|---|---|
| `mcp-approval2` | Fly App (machine) | `fra` | free (≤3 shared-cpu-1x machines under the free allowance) | Hono.js server (port 8787) |
| **Neon project `mcp-approval2`** | **Managed Postgres (external)** | `eu-central-1` (Frankfurt) | **0 €/month (Free Tier, 0.5 GB, 0.25 CU shared)** | Postgres 16, pg_trgm (no pgvector needed for approval2) — TF-managed via `terraform/environments/privat/neon-approval2.tf` |
| `mcp-approval2-openbao` *(optional, deprecated path)* | Fly App (machine + volume) | `fra` | ~2 €/month (1 GB volume + min-1 machine running) | OpenBao KEK provider — alternative to Cloud KMS (default since 2026-05-17, ADR-0005) |

Vertex AI (embeddings + chat) stays a Cloud-API; pay-per-token (~0.10 €/day hobby).

Plus DNS / TLS: `mcp-approval2.fly.dev` is free. Custom domain optional via `fly certs add …` (1 cert/app free).

## Files in this directory

| File | Role |
|---|---|
| `Dockerfile.server` | Multi-stage build for `apps/server` (node:22-alpine, ~150 MB image) |
| `Dockerfile.openbao` | Bakes our prod-config into the upstream OpenBao image |
| `openbao-config.hcl` | OpenBao production config (file-backend, intra-VPC listener) |
| `postgres-init.sql` | *Legacy:* enabled `pgvector` + `pgcrypto` on Fly Postgres. Obsolete since Neon-switch — Neon has both extensions built-in, bootstrap is a 2-line `psql` against `DATABASE_ADMIN_URL` (see `terraform/environments/privat/neon-approval2.tf` header comment) |
| `deploy.sh` | One-shot interactive deploy script (idempotent re-runs) |
| `README.md` | This file |

Companion files at the repo root:

- `fly.toml` — app config for `mcp-approval2`
- `fly.openbao.toml` — app config for `mcp-approval2-openbao`
- `.dockerignore` — keeps node_modules / tests / docs out of the build context

## Step-by-step deploy (~30 minutes)

> **Don't run this from a Coop laptop** — Zscaler blocks Fly's API. Use a private network or a Codespace.

### 1. Prerequisites

```bash
curl -L https://fly.io/install.sh | sh
fly auth login                       # opens browser
fly auth whoami
```

### 2. One-shot deploy

```bash
cd /path/to/mcp-approval2
bash deploy/fly/deploy.sh
```

The script walks through these steps (Postgres-Steps 2/4/5 sind seit 2026-05-17 obsolet — Neon ist TF-managed, deploy.sh überspringt sie und verifiziert nur dass `DATABASE_URL` aus Doppler in Fly-Secrets gepiped wurde):

1. Pre-flight (flyctl present, logged in)
2. ~~Create Fly Postgres cluster~~ → **Neon-Project ist TF-managed** in `terraform/environments/privat/neon-approval2.tf`. Verifikation: `doppler secrets get DATABASE_URL --plain --project mcp-approval2 --config fly | grep -q neon.tech`.
3. Create app shell (`mcp-approval2`) — TF-managed via `fly_app.approval2`
4. ~~`fly postgres attach`~~ → entfällt; Doppler→Fly-Secrets-Sync pusht `DATABASE_URL`+`DATABASE_ADMIN_URL` direkt
5. ~~Run `postgres-init.sql`~~ → Bootstrap-Block einmalig gegen frische Neon-DB. Als **DB-Owner-Role** (`approval_app`, nicht `approval_admin`) ausführen, weil Postgres 15+ den `public`-Schema dem `pg_database_owner` zuweist und nur der explizit granten kann:

   ```sql
   -- Als approval_app (DB-Owner) verbinden:
   CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- kein pgvector für approval2
   GRANT ALL ON SCHEMA public TO approval_admin;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO approval_admin;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO approval_admin;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO approval_admin;
   ```

   Ohne diesen Step scheitern die Migrations (laufen als `approval_admin`) mit `permission denied for schema public`.

6. Deploy OpenBao app (`mcp-approval2-openbao`) — *optional, deprecated path*; Cloud-KMS-Pfad (Default) braucht stattdessen TF-Apply von `gcp-kms.tf`
   - *Wenn OpenBao gewählt:* `fly ssh console -a mcp-approval2-openbao` → `bao operator init` → save unseal keys + root token **out-of-band** → unseal → `bao secrets enable -path=transit transit` → `bao write -f transit/keys/mcp-approval2-kek`
7. Generate + push secrets (RSA-2048 JWT keypair, bearer, session HMAC, internal-token)
8. `fly deploy --config fly.toml` — `fly.toml` hat `[deploy] release_command = "sh -c 'DATABASE_URL=$DATABASE_ADMIN_URL npm run db:migrate'"`, das pro Deploy idempotent die ausstehenden Migrations einspielt (Tracking via `_migrations`-Tabelle). **Pflicht** — ohne `release_command` werden Migrations nie ausgeführt, App antwortet auf `/health` 200, jeder DB-schreibende Endpoint (z.B. `/oauth/register`) wirft 500 weil Tabellen fehlen.
9. Run migrations manuell via `fly ssh console` — nur falls `release_command` mal ausnahmsweise nicht durchgelaufen ist

### 3. Set remaining secrets (manual)

The script generates the in-house secrets; you still need to push the externally-issued ones:

```bash
# Google OAuth front-door
fly secrets set --app mcp-approval2 \
  GOOGLE_OAUTH_CLIENT_ID="…" \
  GOOGLE_OAUTH_CLIENT_SECRET="…"

# OpenBao Static-Token (Solo-Pilot-Pfad; AppRole für production-mode)
fly secrets set --app mcp-approval2 \
  VAULT_TOKEN="…"          # ODER VAULT_APPROLE_ROLE_ID + VAULT_APPROLE_SECRET_ID

# Knowledge-Service URL (Schwester-Repo mcp-knowledge2)
fly secrets set --app mcp-approval2 \
  MCP_KNOWLEDGE_URL="https://knowledge2.ai-toolhub.org"

# Cross-Service-Bridge (gleicher Wert wie in mcp-knowledge2 / privat)
fly secrets set --app mcp-approval2 \
  SERVICE_TOKEN="$(openssl rand -hex 32)" \
  MCP_APPROVAL_INTERNAL_TOKEN="$(openssl rand -hex 32)"

# Cloudflare R2 für Blob + Backup (privat.md §9.1 + §9.2)
# WICHTIG: EU-Jurisdiction-Buckets verlangen `.eu.r2.cloudflarestorage.com` (mit `.eu.`).
# Ohne `.eu.` antwortet R2 mit 403 "Bucket not found".
fly secrets set --app mcp-approval2 \
  BLOB_ENDPOINT="https://<account-id>.eu.r2.cloudflarestorage.com" \
  BLOB_ACCESS_KEY="…" BLOB_SECRET_KEY="…" \
  BLOB_BUCKET="mcp-approval2-blob" \
  BACKUP_BUCKET="mcp-approval2-backup" \
  BACKUP_MASTER_KEY="$(openssl rand -base64 32)"

# JWT für OBO-Token-Signing
fly secrets set --app mcp-approval2 \
  JWT_RS256_PRIVATE_KEY_PEM="$(cat priv.pem)" \
  JWT_RS256_PUBLIC_KEY_PEM="$(cat pub.pem)" \
  JWT_KID="key-$(date -u +%Y-%m-%d)" \
  JWT_SECRET="$(openssl rand -hex 32)"

# Allowlist
fly secrets set --app mcp-approval2 \
  ALLOWED_EMAILS="axelrogg@gmail.com,manuelrogg1@gmail.com"
```

**Vollständige Doppler-Werte-Spec:** [docs/privat.md §6](../../docs/privat.md). Doppler `mcp-approval2 / privat` ist die kanonische Quelle — der Workflow ist Doppler → `fly secrets set` (per Hand oder via Doppler-Fly-Integration).

A new deploy is triggered automatically when secrets are pushed without `--stage`.

### 4. Smoke check

```bash
curl https://mcp-approval2.fly.dev/health
# expect: {"status":"ok","version":"…"}

fly logs -a mcp-approval2 | head -30
fly status -a mcp-approval2
```

## Operations cheatsheet

| Task | Command |
|---|---|
| Tail logs | `fly logs -a mcp-approval2` |
| Show machines | `fly status -a mcp-approval2` |
| List releases | `fly releases list -a mcp-approval2` |
| Rollback | `fly releases rollback <version> -a mcp-approval2` |
| Scale up | `fly scale count 2 -a mcp-approval2` |
| Bump VM | `fly scale vm shared-cpu-2x --memory 1024 -a mcp-approval2` |
| List secrets | `fly secrets list -a mcp-approval2` |
| Rotate secret | `fly secrets set KEY=value -a mcp-approval2` (triggers redeploy) |
| Postgres console | `export ADMIN_URL=$(doppler secrets get DATABASE_ADMIN_URL --plain --project mcp-approval2 --config fly) && psql "$ADMIN_URL"; unset ADMIN_URL` |
| Postgres backups | Neon PITR window (6h Free Tier, 7d on Launch) — Restore via Neon-Console oder `neon` CLI. Cold-Backup: `pg_dump $DATABASE_ADMIN_URL > dump.sql` quartalsweise auf externe Disk |
| Vault unseal (after restart) | `fly ssh console -a mcp-approval2-openbao` → `bao operator unseal …` ×2 |
| Vault UI | `fly proxy 8200:8200 -a mcp-approval2-openbao` → http://localhost:8200 |

## Cost breakdown (Fly.io pricing, May 2026)

| Item | Tier | Cost |
|---|---|---|
| `mcp-approval2` machine | shared-cpu-1x 512 MB, auto-stop | free (under 3-machine allowance) |
| Neon `mcp-approval2` project | Free Tier (0.5 GB, 0.25 CU shared) | **0 €/month** |
| Google Cloud KMS (Default-KEK seit 2026-05-17) | multi-region `eu`, 1 Key + Ops | ~0.30 €/month |
| `mcp-approval2-openbao` *(optional)* | shared-cpu-1x 256 MB, min-1 running | ~2 €/month (machine) — entfällt im Cloud-KMS-Default |
| `vault_data` volume *(optional)* | 1 GB | ~0.15 €/month — entfällt im Cloud-KMS-Default |
| Public bandwidth | 160 GB/month free, then 0.02 $/GB | ~0 € hobby |
| TLS certs | free | 0 € |
| **Subtotal Compute + DB + KMS (Cloud-KMS-Default)** | | **~0.30 €/month** |
| Vertex AI text-embedding-005 | $0.025 / 1M chars input | ~1 €/month at hobby load |
| Vertex AI gemini-2.5-flash | pay-per-token | ~1–3 €/month at hobby load |
| **Total estimate** | | **~2–4 €/month** |

Drop-in alternatives if you want to cut Vertex:
- Replace `VERTEX_*` with Anthropic `claude-haiku` for chat (~3–5 €/month).
- Self-host embedding via a Fly-side `bge-small`-container (~free CPU, slower).

## Rollback / disaster recovery

- **App release rollback**: `fly releases rollback <n> -a mcp-approval2`. Releases keep their secrets, so no re-bootstrap.
- **DB restore**: Neon hat 6h Point-in-Time-Restore auf Free Tier (7d auf Launch). Restore via Neon-Console (Branch-from-time) erzeugt einen neuen Branch mit eigenem Endpoint; `DATABASE_URL` muss dann in Doppler/Fly aktualisiert werden auf den neuen Branch-Host. Cold-Backup-Fallback: vierteljährlicher `pg_dump` auf externe Disk.
- **Vault disaster**: if `vault_data` volume is lost, KEKs are gone → every encrypted column (DEK-wrapped credentials, OAuth refresh-tokens) becomes unreadable. Mitigation: snapshot the volume monthly via `fly volumes snapshots create …`. Restore: create a fresh OpenBao app, mount the snapshot, unseal with the original keys, re-deploy mcp-approval2 (DATABASE_URL points at the same Postgres so all encrypted blobs are still on disk waiting for KEK).

See `docs/runbooks/runbook-fly-deploy.md` for the long-form runbook with troubleshooting.
