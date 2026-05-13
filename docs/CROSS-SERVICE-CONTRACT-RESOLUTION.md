# Cross-Service Contract Resolution: mcp-approval2 ⇄ mcp-knowledge2

> **Status:** RESOLVED (2026-05-13). All twelve drift issues from
> `/workspaces/mcp-knowledge2/docs/CROSS-SERVICE-CONTRACT.md` (§5, D-1..D-12)
> are closed in this repo. D-9 (multi-kind search) ships forward-compatible —
> the joint server-side enablement is queued.

This document is the adapter-side counterpart to the storage-service
contract. For every drift, we record:

- Final wire-shape (what the adapter now sends/parses)
- Where the change landed (files + symbols)
- Test coverage that locks it in
- Reference to the knowledge-service-side source

## Quick Reference

| Drift | Status | Owner | Notes |
|-------|--------|-------|-------|
| D-1 — Error parsing | ✅ resolved | AP | RFC 7807 Problem-Detail + legacy fallback |
| D-2 — `body_b64` instead of `body` | ✅ resolved | AP | base64-encoded inline body |
| D-3 — `mime_type`/`filename`/`embed` | ✅ resolved | AP | added to `CreateObjectArgs` |
| D-4 — Cursor type (number not string) | ✅ resolved | AP | `cursor?: number \| null` |
| D-5 — `next_cursor` envelope key | ✅ resolved | AP | mapped to `nextCursor` |
| D-6 — `createShare` body shape | ✅ resolved | AP | `{granted_to, scope, expires_at?}` snake_case |
| D-7 — `Share.grantedAt` | ✅ resolved | AP | renamed from `createdAt` |
| D-8 — `listShares` envelope | ✅ resolved | AP | unwraps `{items}` |
| D-9 — Multi-kind search | ⏳ partially resolved | BOTH | forward-compatible (single → string, multi → array); server-side multi-kind queued |
| D-10 — `eraseUser` service-token + rich response | ✅ resolved | AP | distinct `serviceToken` option, snake_case body, structured `EraseUserResult` |
| D-11 — `body` only via `?expand=body` | ✅ resolved | AP | `expandBody?: boolean` on `getObject`; base64 lifted to `body` field |
| D-12 — Stale `r2_key` doc-comment | ✅ resolved | AP | comment removed; clarified `blob_key` is DB-only |

---

## 1. Scope of the resolution

Touched files in `mcp-approval2`:

```
packages/adapters/src/knowledge/types.ts          — DTO catalogue rewritten
packages/adapters/src/knowledge/interface.ts      — new args/result shapes
packages/adapters/src/knowledge/http-client.ts    — wire-mapping rewritten
packages/adapters/src/knowledge/errors.ts         — RFC 7807 parser
packages/adapters/src/knowledge/index.ts          — re-exports updated (added GetObjectArgs)
packages/adapters/src/index.ts                    — package-level GetObjectArgs export
packages/adapters/src/knowledge/http-client.test.ts — 43 tests rewritten against new wire shapes
apps/server/src/services/knowledge.ts             — listObjects audit uses nextCursor → hasMore
apps/server/src/services/knowledge.test.ts        — fixtures + EraseUserResult shape adjusted
apps/server/src/services/gdpr.ts                  — pagination uses number-cursor
apps/server/src/routes/knowledge-proxy.ts         — list-cursor schema int; update-patch fields align
apps/server/src/tools/types.ts                    — knowledge.docs.list/skills.list cursor int
apps/server/src/tools/knowledge-tools.ts          — cast typed to number
```

No file in `/workspaces/mcp-knowledge2/` was modified.

---

## 2. Per-drift Resolution

### D-1 — RFC 7807 Problem Details

**Server contract:** `application/problem+json` with
`{type, title, status, detail?, instance?, ...}` on every 4xx/5xx response
(`mcp-knowledge2/src/lib/errors.ts` — `toProblemDetail`).

**Resolution:** `errors.ts:errorFromResponse` now parses the problem-detail
shape first. We:

1. Pick `title (+ detail)` as the human message
2. Pull `code` from the URI suffix of `type` (e.g.
   `https://problems.knowledge2/quota-exceeded` → `quota-exceeded`)
3. Promote `instance` (server-set request-id) over the header fallback
4. Keep a legacy parser branch for `{error: {code, message, details}}` so
   intermediate proxies / older mocks still produce structured messages
5. Plain-text body remains the last-resort fallback

**Tests:** `http-client.test.ts` — "HttpKnowledgeAdapter — error mapping
(RFC 7807)" block. Each status code is verified against a Problem-Detail
mock; legacy + plain-text + header-fallback paths are also covered.

### D-2 — `body_b64` instead of `body`

**Server contract:** `CreateBody.body_b64: z.string().min(1).max(22 KB)` in
`mcp-knowledge2/src/routes/objects.ts`. Server `decodeB64()` → Uint8Array,
then stored either inline or in blob.

**Resolution:** `CreateObjectArgs.body` accepts `Uint8Array | string`. The
adapter base64-encodes via `encodeBodyB64()` (UTF-8 → Buffer for strings,
zero-copy for Uint8Array) and sends `body_b64` on the wire. `body` is no
longer transmitted as a key.

**Tests:** `createObject (D-2 + D-3)` block — verifies binary + UTF-8
roundtrip, plus the JSON wire-body never carries a `body` key.

### D-3 — `mime_type`, `filename`, `embed`

**Server contract:** All three are optional fields on `CreateBody`
(snake_case). `embed: true` triggers the embedding pipeline.

**Resolution:** Added `mimeType`, `filename`, `embed` to `CreateObjectArgs`;
the adapter maps to snake_case keys at the wire level (`mime_type`,
`filename`, `embed`). Plus `triggerHints` → `trigger_hints` and `meta` are
forwarded; these existed on the server but were not in the adapter.

**Tests:** `forwards mime_type/filename/embed as snake_case (D-3)` — every
optional field round-trips and is asserted on the JSON body sent.

### D-4 — Cursor type

**Server contract:** `cursor: z.number()` query param; cursor stores
`updated_at` Unix-ms.

**Resolution:** `ListObjectsArgs.cursor?: number | null`. `null` is
treated identically to `undefined` (no query param emitted). The
server response field `next_cursor` is parsed as `number | null`.

**Caller-side:** `apps/server/src/tools/types.ts` zod schemas for the
knowledge.docs.list / knowledge.skills.list inputs now use
`z.number().int().nonnegative()`. The proxy route in
`knowledge-proxy.ts` uses `z.coerce.number()` so the PWA can send a
query-param string and we parse it server-side.

**Tests:** `listObjects (D-4 + D-5)` block — cursor int, response
`next_cursor` int, end-of-list null.

### D-5 — `next_cursor` vs `cursor`

**Server contract:** Response shape is `{items, next_cursor}`.

**Resolution:** `ObjectsList = {items, nextCursor}`. The adapter maps
`next_cursor` → `nextCursor` on read. `hasMore` is gone — callers
compute `nextCursor !== null` when needed (`knowledge.ts:listObjects`
audit detail still emits a `hasMore` field derived this way, for
back-compat with consumers of the audit log).

**Tests:** Same block as D-4; also `KnowledgeService — listObjects records
count + hasMore` continues to assert derived `hasMore` in audit.

### D-6 — `createShare` body shape

**Server contract:** `{granted_to: uuid, scope, expires_at?: number|null}`.
`resourceKind` is server-derived (looks up the object row).

**Resolution:** `CreateShareArgs.resourceKind` stays in the adapter args
for audit-log context (`knowledge.ts:createShare` records
`resourceKind: args.resourceKind`), but it is **NOT** transmitted. The
wire body is exactly `{granted_to, scope, expires_at?}`. Added
`expiresAt?: number` optional caller-arg.

**Tests:** `createShare (D-6 + D-7)` block — verifies `resourceKind` key
is absent from the wire body; verifies `expires_at` only included when
provided.

### D-7 — `Share.grantedAt`

**Server contract:** `ShareView.grantedAt: integer`.

**Resolution:** `Share.grantedAt: number` (was `createdAt`). Plus added
`Share.expiresAt: number | null` and `Share.resourceKind: ObjectKind`
since the server emits them. Audit log unchanged (operates on the
adapter-level fields).

**Tests:** `createShare (D-6 + D-7)` asserts `share.grantedAt === 1`.

### D-8 — `listShares` envelope

**Server contract:** `{items: ShareView[]}`.

**Resolution:** `http-client.ts:listShares` now unwraps `res.items` and
returns the inner array (interface signature unchanged —
`ReadonlyArray<Share>`).

**Tests:** `listShares (D-8)` mocks the envelope and asserts the
adapter returns the unwrapped array.

### D-9 — Multi-kind search (joint, partially resolved)

**Server contract (today):** `SearchBody.kind?: ObjectKind` (single).
Multi-kind queued.

**Resolution (adapter, forward-compatible):**
- `kinds === undefined || kinds.length === 0` → no `kind` field
- `kinds.length === 1` → server `kind: ObjectKind` (string)
- `kinds.length > 1` → server `kind: ObjectKind[]` (array)

Today the server silently drops the multi-kind array because its zod
schema rejects arrays — but the adapter is forward-compatible: once
the server extends `kind: ObjectKind | ObjectKind[]`, both sides agree
without an adapter redeploy.

**Open joint follow-up:** `mcp-knowledge2` ticket `T-search-multi-kind`.
**Mitigation today:** callers that truly need multi-kind should issue N
queries and merge client-side. mcp-approval2's current consumer
(`knowledge.search` tool) is fine with single-kind.

**Tests:** `search (D-9)` block — single-kind → string; multi-kind →
array; undefined/empty → no kind key.

### D-10 — `eraseUser` service-token + rich response

**Server contract:**
- Auth: Service-Token in `Authorization: Bearer <SERVICE_TOKEN>`
  (validated by `requireServiceToken` middleware in
  `mcp-knowledge2/src/auth/service_token.ts` — NOT JWKS).
- Body: `{user_id, confirmation_token}` snake_case.
- Response: `{status: 'ok'|'partial', deleted: {objects, shares,
  idempotency, uploads, audit_pseudonymised, blobs_deleted,
  blobs_pending}}`.

**Resolution:**
1. `HttpKnowledgeAdapterOptions.serviceToken?: string` — when not set,
   `eraseUser` throws `ServiceError` instead of issuing an unsafe
   JWT-authenticated call.
2. New `serviceFetch()` path bypasses `JwtSigner` and sends the static
   Bearer.
3. `EraseUserResult` carries the full deletion summary in `deleted.*`
   with camelCase keys (e.g. `auditPseudonymised`, `blobsDeleted`).
4. Backwards-compat alias: `result.deletedRows = deleted.objects` keeps
   existing callers like `gdpr.ts:deletedKnowledgeRows = kcResult.deletedRows`
   working without a downstream migration.

**Tests:** `eraseUser (D-10)` block — asserts JWT signer is NOT called,
asserts header is the static service token, asserts body is snake_case,
asserts rich response mapping (with deletedRows alias). Plus a
"serviceToken not configured" failure test.

### D-11 — `KnowledgeObject.body` only via `?expand=body`

**Server contract:** Reads return body_b64 only when
`?expand=body` is requested; default reads are metadata-only.

**Resolution:**
- New `GetObjectArgs.expandBody?: boolean` — when truthy, adapter
  appends `?expand=body`.
- `KnowledgeObject.body?: string | null` — base64-encoded payload
  (caller decodes via `Buffer.from(body, 'base64')`).
- `normaliseObjectView()` lifts `body_b64` → `body` on read; the field
  is omitted entirely when not present (so callers can distinguish
  "didn't ask" from "asked, got null").

**Tests:** `getObject (D-11)` block — no expand param by default; with
`expandBody=true` adds the query param and exposes the base64 string.

### D-12 — Stale `r2_key` doc-comment

**Server contract:** `r2_key` never was on the wire. The DB column is
`blob_key` (Postgres), and it's internal.

**Resolution:** Removed the stale doc-comment in `types.ts`. Added a
fresh comment explaining the actual server-side encoding (inline-blob
vs. S3-object via `blob_key`) and that the wire transport uses
`body_b64` exclusively.

**Tests:** Documentation-only — no runtime test required.

---

## 3. Verification

- `npx tsc --noEmit -p packages/adapters` — clean
- `npx tsc --noEmit -p apps/server` — clean (the only diagnostics are
  pre-existing `@cloudflare/workers-types` resolution errors under
  `src/cf/`, unrelated to the knowledge boundary)
- `npx vitest run` — **407 passed | 1 skipped** across 29 test files
  including the rewritten `http-client.test.ts` (43 tests) and the
  adjusted `apps/server/src/services/knowledge.test.ts` (11 tests)

---

## 4. Live-cutover risk

The mismatch with the server today is invisible at runtime because the
adapter has not been put on the wire yet (Burst 5 not done). Now that
the adapter wire-shape matches the server's zod schemas, the
integration-test harness in `mcp-knowledge2/tests/integration/` can be
pointed at the rebuilt adapter without further drift.

Roll-forward steps when the integration smoke is ready:

1. Ensure `KNOWLEDGE_URL` and `SERVICE_TOKEN` are set on the
   mcp-approval2 side (the latter via the same secret-channel the
   knowledge-service uses for `SERVICE_TOKEN`).
2. Set `JWT_RS256_PRIVATE_KEY_PEM` and publish the matching JWKS so
   `mcp-knowledge2` can verify per-call JWTs.
3. Run `mcp-knowledge2`'s `tests/integration/objects-roundtrip.test.ts`
   against a real adapter instance (replace the in-process fetch stub).
4. Watch the audit-log for the first end-to-end `knowledge.*` events.

---

## 5. Change-Log

- 2026-05-13 — initial resolution, drifts D-1..D-12 all marked closed or
  forward-compatible (D-9). 43 adapter tests + 11 service tests green.
