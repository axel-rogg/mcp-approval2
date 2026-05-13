# `cf/` — Cloudflare Workers runtime adapters

This folder is the **edge-runtime sibling** to the Node deploy. It is an
*additive* code path: nothing in `apps/server/src/*.ts` outside this folder
imports from here, and nothing here imports `@hono/node-server` or any
`node:`-only API (besides `node:crypto`-via-`webcrypto` which the `nodejs_compat`
flag pipes to `globalThis.crypto`).

## Files

| File                     | Role                                                                 |
|--------------------------|----------------------------------------------------------------------|
| `worker.ts`              | The Worker entry-point. Caches the Hono app per isolate.             |
| `app-factory-cf.ts`      | Builds `ServerContext` + `CreateAppDeps` from `env` bindings/secrets and hands off to the shared `createApp`. |
| `d1-adapter.ts`          | Implements `DbAdapter` against Cloudflare D1.                        |
| `vectorize-adapter.ts`   | Local `VecAdapter` against Cloudflare Vectorize (pgvector replacement). |
| `workers-ai-adapter.ts`  | Implements `AiAdapter` against Workers AI (+ optional AI Gateway).   |
| `local-kek.ts`           | Wires `LocalKekProvider` against the CF `MASTER_KEY` secret.         |

The shared **`createApp`** (one folder up) is reused unchanged. The CF factory
constructs the same `ServerContext` shape the Node entry produces — just from
different sources.

## How this differs from the Node deploy

### 1. No row-level security

D1 is SQLite. SQLite has no `current_setting('app.current_user')::uuid` and no
`CREATE POLICY`. The `D1Adapter.scoped(userId)` handle merely *records* the
userId on the `ScopedDb` object — every repository layer above has to enforce
the `WHERE owner_id = ?` filter manually. This is the same contract that the
existing `SqliteDbAdapter` already operates under for tests, so the
applications-side repositories already know how to behave.

If a repository forgets the filter, the deploy is *not* secure in a
multi-user setting. The Node deploy catches the same bug at the DB layer
(RLS denies the row); the CF deploy catches it nowhere. For solo operators
this is acceptable — for anything else, deploy the Node variant.

### 2. KEK provider is `LocalKekProvider`, not OpenBao

The Node deploy runs OpenBao Transit with per-user keys, so an operator who
compromises one user's wrapped DEK can't unwrap another user's data — the
KEK material lives in OpenBao, and the operator only has tokens with narrow
unwrap scopes.

The CF deploy stores a single **master key** as a CF Worker secret. HKDF
derives per-user KEKs from it. The operator can re-derive any user's KEK
offline — meaning the operator can decrypt everything stored under any user.
**Operator-trust is the security boundary.** This is documented and intentional.

If you want a non-operator-trusting deploy, run the Fly variant.

### 3. Vectorize replaces pgvector

| pgvector                  | Vectorize                                       |
|---------------------------|--------------------------------------------------|
| Insert + read in same tx  | Eventually consistent — queries lag by minutes  |
| `WHERE owner_id = $1`     | `filter: { namespace }` + prefixed-id namespacing|
| Per-row updates           | `upsert(records[])`                              |
| Schema-typed columns      | Metadata fields declared with `--type=string`    |

The adapter mirrors the namespace into both the vector id (`<ns>:<id>`) and a
required metadata field. Repositories MUST pass a namespace — leaving it
blank throws.

### 4. AI: Workers AI by default, Anthropic/OpenAI via AI Gateway

The default chat/embed model is `@cf/baai/bge-base-en-v1.5` (768-dim, cosine)
+ `@cf/meta/llama-3.1-8b-instruct`. To use a stronger model, set
`AI_GATEWAY_URL` + `AI_GATEWAY_API_KEY`, then pass
`model: 'gateway:anthropic:claude-3-5-sonnet-latest'` to `chat()`.

Embeddings still go through Workers AI even with the gateway configured —
that's where the price/perf sweet spot is for a small index.

### 5. Transactions are best-effort

D1 cannot maintain a transaction across `await`s. `D1Adapter.transaction(fn)`
simply runs `fn` with a scoped handle and returns its result. If `fn` throws
between two writes, the first write is *not* rolled back. Repositories that
need atomic multi-row writes must batch their statements via `db.batch([])`
themselves, or migrate that workload to the Node deploy.

## Known gaps

- Migrations 0002 through 0007 (oauth, sub-mcp, rate-limit-audit-view,
  approvals, cost ledger, user dek seeds) are NOT yet ported to D1 dialect.
  Until they are, the corresponding features either degrade gracefully (the
  app-factory only mounts routes for which the underlying tables exist) or
  fail at the first DB call. Port them under `apps/server/migrations-d1/`
  one by one.
- `LocalKekProvider.destroyKey` is in-memory only on this deploy. After an
  isolate eviction the "shred" is lost. Real Art. 17 erasure on CF requires
  deleting the user's row (so the kek_ref vanishes) AND rotating the master
  key (so historical wrap material can't be re-derived). Document this in
  the runbook before letting any non-operator data into the deploy.
- WebAuthn-PRF: browser-side mechanics are identical; the server-side
  challenge validation only depends on `@simplewebauthn/server`, which works
  under `nodejs_compat`. Smoke-test before depending on it.
