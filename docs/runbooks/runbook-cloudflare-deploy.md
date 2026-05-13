# Runbook: Cloudflare Workers Deploy

> Operational handbook for the **Cloudflare alternative deploy** of
> mcp-approval2. The supported production path is Fly + OpenBao + Postgres
> (see `runbook-pilot-onboarding.md`). This runbook covers the free-tier CF
> path for a single trusting operator.

## Audience

Single operator who deployed via `deploy/cloudflare/deploy.sh` and now needs
to: rotate keys, restore from backup, debug a 500, or fall back to the
Fly variant.

## Pre-flight (one-time, before first deploy)

1. Cloudflare account exists and is logged in: `npx wrangler login`.
2. Google OAuth Client (web application) created with redirect URI
   `https://mcp-approval2.<account>.workers.dev/auth/google/callback`.
3. 32-byte master key generated and stored offline:
   `openssl rand -base64 32 > master.key && chmod 600 master.key`.
   Keep an offline backup — losing this key is **unrecoverable**, every
   credentials row becomes ciphertext-of-nothing.
4. RS256 keypair generated: `openssl genpkey …` per the deploy README.
5. Optional: custom domain pointed at `mcp-approval2.<account>.workers.dev`
   via Cloudflare DNS; bump `wrangler.jsonc` `routes` + `ORIGIN`/`RP_*` vars.

## Day-1: bootstrap + deploy

```bash
bash deploy/cloudflare/deploy.sh
# follow prompts to set secrets via wrangler secret put
bash deploy/cloudflare/deploy.sh
# the second pass runs migrations + deploys
```

Smoke-test after first deploy:

```bash
curl https://mcp-approval2.<acct>.workers.dev/health
# expect 200 OK with JSON body { ok: true, ... }
```

## Day-N: re-deploy after a code change

```bash
# fast path
npx wrangler deploy

# with fresh migrations
npx wrangler d1 migrations apply mcp-approval2 --remote
npx wrangler deploy
```

GitHub Actions: if you wire up CI, the workflow needs the
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` secrets and calls
`npx wrangler deploy` on push to `main`. Mirror the existing Fly workflow
under `.github/workflows/` rather than freshly inventing one.

## Rotating the master key

Master-key rotation under `LocalKekProvider` is a full re-wrap of every
`credentials.wrapped_dek`. Procedure:

1. Generate a new master key: `openssl rand -base64 32 > master.new.key`.
2. Export every credentials row's plaintext **using the old key, in a one-off
   maintenance Worker** (or via the Fly deploy if you can dual-run briefly).
3. Set the new secret: `wrangler secret put MASTER_KEY < master.new.key`.
4. Re-import the credentials rows; new rows wrap under the new HKDF derivation.
5. Verify by login + a credentials read on every active user.
6. Delete the old key file.

If this sounds painful, that's because it is — the Fly + OpenBao path has
proper rotation primitives. Plan a rotation cadence (e.g. yearly) and stick
to it.

## Recovery from R2 backup

The Fly deploy ships a monthly D1/R2 backup cron. The CF deploy has NO
equivalent yet. Suggested workaround until one ships:

```bash
# Dump current D1 to local SQLite file
npx wrangler d1 export mcp-approval2 --output backup-$(date -u +%Y-%m).sql --remote

# Upload to R2 under backup/<ts>.sql
npx wrangler r2 object put mcp-approval2-eu/backup/$(date -u +%Y-%m).sql \
  --file=backup-$(date -u +%Y-%m).sql

# To restore — load the SQL into a freshly-bootstrapped D1.
npx wrangler d1 execute mcp-approval2 --file=backup-2026-05.sql --remote
```

Automate this via a scheduled Worker once you have >1 month of real data.
The CF deploy does ship a `vectorize` index — it's not backed up by CF.
Re-embed from D1 row data after a restore.

## Debug: 500 on /mcp

1. Tail logs: `npx wrangler tail mcp-approval2`.
2. Common causes:
   - **Missing secret** — log line `mcp-approval2/cf: required env var "X" is missing`.
     Fix: `wrangler secret put X`.
   - **D1 migrations not applied** — log line about missing table `audit_log`
     or similar. Fix: `wrangler d1 migrations apply mcp-approval2 --remote`.
   - **Vectorize eventual consistency** — first query after an upsert can
     come back empty for several minutes. Check
     `wrangler vectorize info mcp-approval2-objects` for the
     `processedUpToDatetime` field.
3. If you suspect a bad Worker version, roll back to a previous deploy:
   `npx wrangler rollback`.

## Disabling chat / embeddings (cost control)

If Workers AI hits the free-tier ceiling, set `AI_GATEWAY_URL` and route to
a bring-your-own-key Anthropic/OpenAI account:

```bash
npx wrangler secret put AI_GATEWAY_API_KEY  # paste your Anthropic key
# patch wrangler.jsonc vars.AI_GATEWAY_URL to your Gateway URL
npx wrangler deploy
```

Repositories pick this up via the chat call site (model arg with
`gateway:<provider>:<model>`). Embedding stays on Workers AI.

## Fallback to Fly

The CF deploy is intentionally a *side door*. To migrate to the Fly variant:

1. `wrangler d1 export mcp-approval2 --output dump.sql --remote`
2. Spin up Postgres on Fly per `runbook-pilot-onboarding.md`.
3. Translate the SQLite dump to Postgres (the data shape is congruent —
   only types change: TEXT-UUID → UUID, INTEGER booleans → BOOLEAN,
   TEXT JSON → JSONB).
4. Bootstrap OpenBao, generate per-user KEKs, **re-wrap every
   credentials row using the export-during-rotation procedure above**.
5. Switch DNS, decommission the Worker (`wrangler delete`).

This is non-trivial — budget half a day. The CF deploy is meant to be the
last stop, not the first stop, for any data you care about.

## See also

- `apps/server/src/cf/README.md` — code-side architecture differences.
- `deploy/cloudflare/README.md` — deploy procedure + cost estimate.
- `docs/runbooks/runbook-pilot-onboarding.md` — the Fly path.
- `docs/runbooks/runbook-token-rotation.md` — service-token rotation
  (applies to both deploys).
- `docs/runbooks/runbook-incident-response.md` — generic incident triage.
