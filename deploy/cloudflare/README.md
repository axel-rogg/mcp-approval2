# Cloudflare Workers Deployment (Private Free-Tier Variant)

> **Status: alternative deploy target, not production primary.**
> The supported production path is **Fly.io + Postgres + OpenBao + MinIO**
> (see `deploy/fly/`). This folder ships a free-tier Cloudflare-Workers
> alternative for solo operators who accept the trust trade-offs below.

## When to pick which

| Concern                       | Fly.io (primary)       | Cloudflare (this folder)        |
|-------------------------------|------------------------|----------------------------------|
| Cost (single operator)        | ~5 EUR/month           | 0 EUR/month (free tier)          |
| Multi-user (>1 user)          | full RLS + per-user DEK | technically possible, repo-pattern dependent — see Trust Model |
| KMS                           | OpenBao Transit (per-user keys) | LocalKekProvider on a single CF Worker secret |
| Database                      | Postgres 16 + pgvector | D1 (SQLite) + Vectorize          |
| Embeddings / chat             | Vertex AI (EU)         | Workers AI (+ optional AI Gateway → Anthropic/OpenAI) |
| Atomic multi-statement tx     | full ACID              | best-effort (D1 limitation)      |
| GDPR data residency           | configurable (Fly EU regions, OpenBao in EU) | CF runs globally, R2 in EU jurisdiction; KEK is everywhere CF runs |

If any of the right-column items is a hard "no" for your threat model,
deploy the Fly variant. The CF variant is meant as a "good enough for me
alone, on my own data" deploy.

## Quickstart

```bash
# 1) Log into Cloudflare
npx wrangler login

# 2) One-shot bootstrap + deploy
bash deploy/cloudflare/deploy.sh
```

`deploy.sh` is idempotent. On the first run it creates D1 / R2 / Vectorize,
prints the secrets you need to set, then aborts. Set the secrets via
`wrangler secret put …`, re-run, and the second pass runs migrations +
deploys the Worker.

## What gets created

| Resource        | Name                          | Notes                                  |
|-----------------|-------------------------------|----------------------------------------|
| D1 database     | `mcp-approval2`               | SQLite at the edge, ~5 GB free quota   |
| R2 bucket       | `mcp-approval2-eu`            | EU jurisdiction, 10 GB free quota      |
| Vectorize index | `mcp-approval2-objects`       | 768-dim cosine — matches bge-base-en-v1.5 |
| Worker          | `mcp-approval2`               | published on `mcp-approval2.<acct>.workers.dev` |

## Secrets you must set

Run each command, paste the value when prompted:

```bash
npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
npx wrangler secret put MASTER_KEY                  # openssl rand -base64 32
npx wrangler secret put JWT_SECRET                  # openssl rand -hex 32
npx wrangler secret put JWT_RS256_PRIVATE_KEY_PEM   # PKCS#8 PEM body
npx wrangler secret put JWT_RS256_PUBLIC_KEY_PEM    # SPKI PEM body
npx wrangler secret put JWT_KID                     # any stable id, e.g. "key-2026-05"
npx wrangler secret put MCP_APPROVAL_INTERNAL_TOKEN # openssl rand -hex 32
```

Generate the RS256 keypair (one-time, before the bootstrap):

```bash
openssl genpkey -algorithm RSA -out priv.pem -pkeyopt rsa_keygen_bits:2048
openssl pkey -in priv.pem -pubout -out pub.pem
# paste priv.pem contents into JWT_RS256_PRIVATE_KEY_PEM
# paste pub.pem  contents into JWT_RS256_PUBLIC_KEY_PEM
# then delete the local files
```

## Migrations

Migrations live in **two** parallel folders:

- `apps/server/migrations/`   — canonical (Postgres dialect)
- `apps/server/migrations-d1/` — D1 / SQLite-dialect ports (subset for now)

The Postgres folder is source of truth. The D1 folder is hand-ported because
RLS, JSONB, BYTEA, and `DO $$ … END $$` blocks don't translate via a generator.
Currently only `0001_initial.sql` is ported; features that depend on later
migrations (sub-MCP gateway, approvals table, cost ledger, per-user DEK seeds)
need explicit ports before they light up under the CF deploy. See
`migrations.toml` for the TODO list.

Run migrations against the deployed D1:

```bash
npx wrangler d1 migrations apply mcp-approval2 --remote
```

Or against a local in-memory dev D1:

```bash
npx wrangler d1 migrations apply mcp-approval2 --local
```

## Architecture differences vs Node

See `apps/server/src/cf/README.md`. Short version: D1 has no RLS, KEK is a
single master key on Workers, AI calls go through Workers AI by default,
multi-statement transactions are best-effort.

## Cost estimate (free tier, single operator)

| Metric             | Free quota         | Realistic monthly hit |
|--------------------|--------------------|------------------------|
| Workers requests   | 100k/day           | <5k/day                |
| Workers AI neurons | ~10k/month         | <2k/month              |
| D1 reads           | 5M/day             | <50k/day               |
| D1 writes          | 100k/day           | <5k/day                |
| D1 storage         | 5 GB total         | ~50 MB                 |
| R2 storage         | 10 GB total        | ~500 MB                |
| R2 ops (Class A)   | 1M/month           | <10k/month             |
| Vectorize queries  | 30M dims/month     | <1M dims/month         |

= **0 EUR/month** for typical single-operator usage. The next paid tier
trigger is usually Workers AI (heavy chat workload) — switch to the AI
Gateway → Anthropic/OpenAI path and bring your own API key in that case.

## Runbook

See `docs/runbooks/runbook-cloudflare-deploy.md` for ops procedures (rotate
master key, restore from R2 backup, debug a stuck Worker, fall back to the
Fly deploy).
