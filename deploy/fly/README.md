# Fly.io Deployment — mcp-approval2

Private/hobby deploy of `mcp-approval2` on Fly.io. Target footprint: **~5–10 €/month**.

## Architecture (3 Fly resources)

| Resource | Type | Region | Cost (est) | Purpose |
|---|---|---|---|---|
| `mcp-approval2` | Fly App (machine) | `fra` | free (≤3 shared-cpu-1x machines under the free allowance) | Hono.js server (port 8787) |
| `mcp-approval2-pg` | Fly Postgres cluster | `fra` | ~3 €/month (shared-cpu-1x + 3 GB volume) | Postgres 16 + pgvector |
| `mcp-approval2-openbao` | Fly App (machine + volume) | `fra` | ~2 €/month (1 GB volume + min-1 machine running) | KEK provider (OpenBao) |

Vertex AI (embeddings + chat) stays a Cloud-API; pay-per-token (~0.10 €/day hobby).

Plus DNS / TLS: `mcp-approval2.fly.dev` is free. Custom domain optional via `fly certs add …` (1 cert/app free).

## Files in this directory

| File | Role |
|---|---|
| `Dockerfile.server` | Multi-stage build for `apps/server` (node:22-alpine, ~150 MB image) |
| `Dockerfile.openbao` | Bakes our prod-config into the upstream OpenBao image |
| `openbao-config.hcl` | OpenBao production config (file-backend, intra-VPC listener) |
| `postgres-init.sql` | Enables `pgvector` + `pgcrypto` on the Fly Postgres database |
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

The script walks through 8 steps and pauses before every destructive action:

1. Pre-flight (flyctl present, logged in)
2. Create Fly Postgres cluster (`mcp-approval2-pg`)
3. Create app shell (`mcp-approval2`)
4. `fly postgres attach` (injects `DATABASE_URL` as a secret)
5. Run `postgres-init.sql` (enable pgvector + pgcrypto)
6. Deploy OpenBao app (`mcp-approval2-openbao`)
   - **Manual step**: `fly ssh console -a mcp-approval2-openbao` → `bao operator init` → save unseal keys + root token **out-of-band** → unseal → `bao secrets enable -path=transit transit` → `bao write -f transit/keys/mcp-approval2-kek`
7. Generate + push secrets (RSA-2048 JWT keypair, bearer, session HMAC, internal-token)
8. `fly deploy --config fly.toml`
9. Run migrations via `fly ssh console`

### 3. Set remaining secrets (manual)

The script generates the in-house secrets; you still need to push the externally-issued ones:

```bash
# Google OAuth front-door
fly secrets set --app mcp-approval2 \
  GOOGLE_OAUTH_CLIENT_ID="…" \
  GOOGLE_OAUTH_CLIENT_SECRET="…"

# OpenBao AppRole (after enabling AppRole auth in OpenBao itself)
fly secrets set --app mcp-approval2 \
  VAULT_TOKEN="…"          # or VAULT_APPROLE_ROLE_ID + VAULT_APPROLE_SECRET_ID

# Knowledge-Service URL (once mcp-knowledge2 is deployed)
fly secrets set --app mcp-approval2 \
  KNOWLEDGE_URL="https://mcp-knowledge2.fly.dev"

# S3-compatible blob (e.g. Backblaze B2, or skip if not using yet)
fly secrets set --app mcp-approval2 \
  S3_ENDPOINT="…" S3_ACCESS_KEY_ID="…" S3_SECRET_ACCESS_KEY="…" \
  S3_BUCKET="mcp-approval2" S3_REGION="eu-central-1"
```

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
| Postgres console | `fly postgres connect -a mcp-approval2-pg -d mcp_approval2` |
| Postgres backups | `fly postgres backup list -a mcp-approval2-pg` (daily automatic) |
| Vault unseal (after restart) | `fly ssh console -a mcp-approval2-openbao` → `bao operator unseal …` ×2 |
| Vault UI | `fly proxy 8200:8200 -a mcp-approval2-openbao` → http://localhost:8200 |

## Cost breakdown (Fly.io pricing, May 2026)

| Item | Tier | Cost |
|---|---|---|
| `mcp-approval2` machine | shared-cpu-1x 512 MB, auto-stop | free (under 3-machine allowance) |
| `mcp-approval2-pg` cluster | shared-cpu-1x + 3 GB volume | ~3 €/month |
| `mcp-approval2-openbao` | shared-cpu-1x 256 MB, min-1 running | ~2 €/month (machine) |
| `vault_data` volume | 1 GB | ~0.15 €/month |
| Public bandwidth | 160 GB/month free, then 0.02 $/GB | ~0 € hobby |
| TLS certs | free | 0 € |
| **Subtotal Fly** | | **~5–6 €/month** |
| Vertex AI text-embedding-005 | $0.025 / 1M chars input | ~1 €/month at hobby load |
| Vertex AI gemini-2.5-flash | pay-per-token | ~1–3 €/month at hobby load |
| **Total estimate** | | **~7–10 €/month** |

Drop-in alternatives if you want to cut Vertex:
- Replace `VERTEX_*` with Anthropic `claude-haiku` for chat (~3–5 €/month).
- Self-host embedding via a Fly-side `bge-small`-container (~free CPU, slower).

## Rollback / disaster recovery

- **App release rollback**: `fly releases rollback <n> -a mcp-approval2`. Releases keep their secrets, so no re-bootstrap.
- **DB restore**: Fly Postgres takes daily automatic backups. `fly postgres backup restore <id>` creates a new cluster from the snapshot; re-attach to the app.
- **Vault disaster**: if `vault_data` volume is lost, KEKs are gone → every encrypted column (DEK-wrapped credentials, OAuth refresh-tokens) becomes unreadable. Mitigation: snapshot the volume monthly via `fly volumes snapshots create …`. Restore: create a fresh OpenBao app, mount the snapshot, unseal with the original keys, re-deploy mcp-approval2 (DATABASE_URL points at the same Postgres so all encrypted blobs are still on disk waiting for KEK).

See `docs/runbooks/runbook-fly-deploy.md` for the long-form runbook with troubleshooting.
