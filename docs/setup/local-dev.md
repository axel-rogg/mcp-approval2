# Local Development — 5-Minute Quickstart

This guide walks you from `git clone` to a running mcp-approval2 dev-stack:
Postgres 16 + pgvector, OpenBao (Vault-fork) for KEK-management, and MinIO
as a local S3-compatible blob-store.

Architecture-Context: [PLAN-architecture-v1.md](../plans/active/PLAN-architecture-v1.md)
(see §5 Vault, §7 Storage, §8 AI).

## Prerequisites

| Tool | Min Version | Notes |
|---|---|---|
| Docker | 24.x | with `docker compose` v2 (built-in on Docker Desktop) |
| Node.js | 20.x | matches `engines.node` in `package.json` |
| npm | 10.x | comes with Node 20 |
| openssl | any | for key-generation (most platforms ship this) |
| curl | any | used by `vault-init.sh` |

On Linux you'll also want your user in the `docker` group so `docker` works
without `sudo`.

## Quickstart

```bash
# 1. Clone + install
git clone git@github.com:axel-rogg/mcp-approval2.git
cd mcp-approval2
npm install

# 2. Bootstrap (creates .env, starts services, runs migrations)
bash scripts/dev.sh
```

That's it. The script is idempotent — re-run it any time. When it finishes
you should see:

- Postgres at `postgres://postgres:postgres@localhost:5432/mcp_approval2`
- OpenBao at `http://localhost:8200` (root-token in `.env`)
- MinIO at `http://localhost:9000` (web-console at `http://localhost:9001`)
- The dev-server at `http://localhost:8787` (if `apps/server` has a `dev` script)

Health-check:

```bash
curl -sS http://localhost:8787/health
```

If `apps/server` is still in Phase-0 skeleton (no `dev` script yet),
`scripts/dev.sh` will exit cleanly after bootstrap and tell you to start
the server manually once it exists.

## What the bootstrap does

1. **`.env` from `.env.example`** if missing.
2. **`docker compose up -d`** — starts Postgres, OpenBao (dev-mode), MinIO.
3. **Waits for Postgres healthy** (~10s), then `CREATE EXTENSION vector`.
4. **`scripts/vault-init.sh`** — enables the OpenBao transit-engine at
   `transit/` and creates a sample key `transit/keys/user-default` for
   smoke-tests. Idempotent.
5. **`npm run db:migrate -w apps/server`** — applies Drizzle migrations.
6. **`npm run dev -w apps/server`** — starts the dev-server (if defined).

## Generating real keys for `.env`

The defaults are dev-only. To exercise the auth/crypto paths you'll need
actual key material. Generate it once and paste into `.env`:

```bash
# HMAC secret for session-JWTs (single line; treat as a password)
openssl rand -base64 64

# RSA-2048 keypair for service-JWTs (mcp-approval2 → mcp-knowledge2)
openssl genrsa -out /tmp/priv.pem 2048
openssl rsa -in /tmp/priv.pem -pubout -out /tmp/pub.pem
# then base64-encode the PEMs or escape \n in your .env loader
base64 -w0 /tmp/priv.pem  # JWT_PRIVATE_KEY
base64 -w0 /tmp/pub.pem   # JWT_PUBLIC_KEY
rm /tmp/priv.pem /tmp/pub.pem

# Master-key for the LocalKekProvider dev-fallback
openssl rand -base64 32     # MASTER_KEY_BASE64
```

## Common commands

| Task | Command |
|---|---|
| Start services + dev-server | `bash scripts/dev.sh` |
| Just bootstrap, no server | `bash scripts/dev.sh --no-serve` |
| Stop services | `docker compose down` (keeps data) |
| Stop + wipe Postgres | `bash scripts/db-reset.sh` |
| psql shell | `bash scripts/db-shell.sh` |
| Vault/Bao CLI | `bash scripts/vault-shell.sh` |
| One-shot Vault read | `bash scripts/vault-shell.sh bao read transit/keys/user-default` |
| Apply new migration | `npm run db:migrate -w apps/server` |
| Generate migration | `npm run db:generate -w apps/server` |
| Tail container logs | `docker compose logs -f` |

## Service URLs

| Service | URL | Credentials |
|---|---|---|
| Postgres | `postgres://localhost:5432/mcp_approval2` | `postgres / postgres` |
| OpenBao | http://localhost:8200 | root-token = `$VAULT_TOKEN` from `.env` |
| OpenBao UI | http://localhost:8200/ui | same token |
| MinIO S3 | http://localhost:9000 | `minioadmin / minioadmin` |
| MinIO Console | http://localhost:9001 | `minioadmin / minioadmin` |
| Dev-server | http://localhost:8787 | — |

## Troubleshooting

### "port is already allocated"

Something else (a prior Postgres, another project) is bound to 5432 / 8200 /
9000 / 9001 / 8787. Options:

- Stop the offender: `lsof -nP -iTCP:5432 -sTCP:LISTEN` (Linux/macOS)
- Or override the host-side port in `docker-compose.yml` (e.g.
  `"127.0.0.1:5433:5432"`) and update `DATABASE_URL` accordingly.

### Postgres healthcheck never becomes healthy

Run `docker compose logs postgres` and look for the error. Most common
causes are corrupt volumes (`docker volume rm mcp-approval2-postgres-data`
to wipe — destructive!) or a password mismatch between `.env` and an
already-initialized volume. `bash scripts/db-reset.sh --yes` fixes both.

### OpenBao root-token "permission denied"

Dev-mode regenerates a fresh in-memory state on every container restart.
The root-token is whatever you set as `VAULT_TOKEN` in `.env`. If you
changed `.env` *after* the container booted, restart it:

```bash
docker compose restart openbao
bash scripts/vault-init.sh
```

In dev-mode OpenBao stores nothing on disk, so after restart all transit-keys
must be recreated. The init-script handles `user-default` for you.

### `pgvector` extension errors on first migrate

`scripts/dev.sh` runs `CREATE EXTENSION IF NOT EXISTS vector` against the
user-DB before migrations. If you bypassed the script and ran migrations
manually, do this once:

```bash
bash scripts/db-shell.sh -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### MinIO bucket missing

The `minio-init` one-shot container creates `${S3_BUCKET}` on first boot
(idempotent). If you renamed `S3_BUCKET` in `.env` after the first boot,
either rerun the init explicitly:

```bash
docker compose run --rm minio-init
```

or create it manually in the MinIO web-console at http://localhost:9001.

### Zscaler / corporate proxy blocks Docker image pulls

Same problem the parent repo (`mcp-approval`) has against `*.ai-toolhub.org`.
Either pull images from a non-corporate network and let Docker cache them,
or configure your corporate-proxy in `~/.docker/config.json`.

### Reset everything

```bash
docker compose down -v       # stop + delete volumes
rm .env                      # if you want a fresh copy from .env.example
bash scripts/dev.sh
```

## Next steps

- Phase 0 progress: see [PLAN-architecture-v1.md §11](../plans/active/PLAN-architecture-v1.md#11-roll-out-phasen-12-14-wochen)
- Repo of the parallel storage-service: [mcp-knowledge2](https://github.com/axel-rogg/mcp-knowledge2)
- ADRs (decision-records) live in `docs/adr/` (TBD; mirrors the 22
  decisions from the v0 session)
