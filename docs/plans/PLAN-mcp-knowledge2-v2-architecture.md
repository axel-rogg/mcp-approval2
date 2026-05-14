# PLAN — mcp-knowledge2 v2 Architektur (Greenfield-Rewrite)

> **Status:** Plan v2 — Reviewer-Findings adressiert (2026-05-14). Bereit fuer Phase 0.
>
> Greenfield-Rewrite des Storage-Service knowledge-core (heute CF-Workers
> auf `knowledge.ai-toolhub.org`). Ziel: gleiche Ziel-Architektur wie
> mcp-approval2 — Hetzner-Pilot jetzt, GCP Cloud Run spaeter — und voll
> portabel via Adapter-Pattern.
>
> Schwester-Plan: [PLAN-architecture-v1.md](active/PLAN-architecture-v1.md)
> (mcp-approval2 Auth/Approval-Server). Review-Brief:
> [docs/reviews/REVIEW-mcp-knowledge2-v2-architecture.md](../reviews/REVIEW-mcp-knowledge2-v2-architecture.md).

---

## 1. Zielarchitektur

**Hetzner-Phase (Pilot):**
- Postgres 16 mit `pgvector` (existing compose-service `postgres`, separate Datenbank `knowledge2` — schon angelegt in [postgres-init.sql](../../deploy/hetzner/postgres-init.sql)).
- Hetzner Object Storage als S3-Backend (`https://fsn1.your-objectstorage.com`, EU-Falkenstein).
- Vertex AI EU (`europe-west4`) fuer Embeddings (`text-embedding-005`, 768-dim) + optional Chat (Quality-Gate).
- OpenBao (compose-service `openbao`, Transit-Engine) als KEK-Provider. mcp-knowledge2 nutzt `vault://transit/keys/knowledge2` (single-tenant Pilot) — Multi-User-Cutover-Pfad in §5.3.
- JWKS-Pull von `https://mcp2.ai-toolhub.org/.well-known/jwks.json` zur RS256-JWT-Validation (sub=userId).

**GCP-Phase (Phase 2, kein Code-Refactor):**
- Cloud SQL Postgres mit `pgvector`-Extension.
- GCS-Bucket statt Hetzner Object Storage — gleicher `S3BlobAdapter`, anderer Endpoint + Auth (oder nativer `GcsBlobAdapter`, identisches Interface).
- Vertex AI bleibt identisch (gleiche Region, gleiche Library).
- Cloud KMS statt OpenBao — neue `CloudKmsKekProvider`-Impl hinter `KekProvider`-Interface, Code im App-Layer unveraendert.

**Adapter-Pattern:** kein Cloudflare-Erbe im App-Daten-Pfad. Kein D1/R2/Vectorize/Workers-AI in `apps/knowledge/src/`. Adapter-Boundary identisch zu mcp-approval2 (`DbAdapter`, `BlobAdapter`, `KekProvider`, `AiAdapter`). Wechsel von Hetzner → GCP ist ein Doppler-Config + Compose-File-Tausch, kein `npm`-Diff.

---

## 2. Repo-Layout-Entscheidung

**Wahl: Option B — Monorepo-Erweiterung als `apps/knowledge/` in `/workspaces/mcp-approval2`.**

Constraint "gleiche Target-Architektur" ist nur ehrlich erreichbar wenn der Adapter-Code wirklich derselbe ist, nicht eine geforkte Kopie die driftet. Option A produziert zwei Vertex-/OpenBao-Adapter-Impls. Option B macht den Boundary HTTP-only und laesst Build-Code shared. Coupling-Risiko (Direct-Import quer-rein) gemildert durch ESLint `no-restricted-paths` zwischen `apps/server/**` und `apps/knowledge/**`. Das alte CF-Worker-Repo `axel-rogg/mcp-knowledge` bleibt read-only bis Sunset (dann GH-Archive).

---

## 3. Package-Struktur

```
/workspaces/mcp-approval2/
├── packages/
│   ├── core/                          # SHARED — crypto, ULID, Result-Types
│   └── adapters/                      # SHARED — Db / Blob / Kek / Ai / Knowledge
└── apps/
    ├── server/                        # mcp-approval2 (bestehend)
    ├── web/                           # PWA (bestehend)
    └── knowledge/                     # NEU — mcp-knowledge2 v2
        ├── package.json               # @mcp-approval2/knowledge
        ├── tsconfig.json
        ├── drizzle.config.ts
        ├── migrations/                # 0001_objects.sql + 0002_refs_tags.sql + 0003_uploads_idem.sql
        ├── scripts/                   # migrate.ts + health-check.ts
        ├── src/
        │   ├── index.ts               # Hono-Boot (translateBootEnv + waitForDb + waitForVault + waitForApprovalJwks)
        │   ├── app-factory.ts         # createApp({config, db, blob, kek, ai})
        │   ├── lib/                   # config.ts (zod), db.ts, context.ts, aad.ts (knowledge-lokal, §6 H1)
        │   ├── auth/                  # jwks.ts (JWKS-pull + preflight), jwt.ts, bearer.ts (Service-Token)
        │   ├── routes/                # objects / refs / tags / shares / search / uploads / internal / mcp / health
        │   ├── objects/api.ts         # CRUD-Layer (port aus mcp-knowledge; R2→S3, D1→PG, Vec→pgvector)
        │   ├── refs/api.ts            # native /v1/refs Routen (siehe §4)
        │   ├── tags/api.ts            # native /v1/tags Routen (siehe §4)
        │   ├── search/hybrid.ts       # RRF (FTS-tsvector + pgvector) — multi-kind support (D-9)
        │   ├── embed/vertex.ts        # AiAdapter-call statt env.AI
        │   ├── pii/mask.ts            # 1:1 port
        │   ├── quality/               # judge.ts + rubric.ts — Vertex-Chat via AiAdapter
        │   ├── apps/api.ts            # composable-apps state-layer
        │   ├── skills/api.ts          # manifest + refs (nutzt /v1/refs)
        │   ├── mcp/                   # registry + per-Familie Tool-Slices
        │   ├── cron/                  # Phase-1: node-cron in-process; Phase-3: pg-boss
        │   └── middleware/            # idempotency (PG-backed) + audit
        └── tests/                     # vitest
```

### Port-Inventur

**1:1 portierbar (trivial):** `src/crypto/*` (oder direkt `@mcp-approval2/core/crypto` — siehe §6 H1), `src/pii/mask.ts`, `src/ulid.ts` (in core schon vorhanden — drop), `src/search/scorers.ts`, `src/apps/blocks/*` (22 blocks Schema-Defs), `src/util/*`.

**Mittlerer Port-Aufwand:** `src/quality/{judge,rubric}.ts` (AI-Gateway-Slug → `aiAdapter.chat()`), `src/apps/{types,types_registry,legacy_to_layout,action_router}` (objects-API-coupling), `src/middleware/idempotency.ts` (KV → PG-Tabelle), `src/objects/api.ts` (Rename `'app_state'` → `'app'` — §4 C1).

**Adapter-Umweg pflicht:**

| CF-Concept | v2-Mapping |
|---|---|
| `env.DB` (D1) | `db.scoped(userId)` + Drizzle |
| `env.R2` | `blob.put/get` (S3BlobAdapter) |
| `env.OBJECTS_VEC` (Vectorize) | `pgvector`-Spalte + `src/search/hybrid.ts` — strong-consistent (§5.1) |
| `env.AI.run('@cf/baai/bge-m3')` | `ai.embed()` (Vertex `text-embedding-005`, 768-dim) |
| `env.IDEMPOTENCY_KV` | PG-Tabelle `idempotency_keys (key, response_body, expires_at)` |
| `env.MASTER_KEY` | `kek.wrap()` (OpenBao Transit, key `knowledge2`; multi-user-future siehe §5.3) |
| `wrangler.jsonc triggers.crons` | node-cron in-process (Phase 1), pg-boss (Phase 3) |
| FTS5-Virtual-Table | Postgres `tsvector`-Spalte + GIN-Index |

**Komplett neu:** `src/auth/jwks.ts` (JWKS-Pull + `waitForApprovalJwks()`-Boot-Preflight, §7.1) und `src/refs/` + `src/tags/` (native Routes, §4 C2).

---

## 4. Daten-Modell-Entscheidungen (Reviewer C1+C2+D-9)

### 4.1 ObjectKind = `'doc' | 'skill' | 'app' | 'memo'` (C1)

**Entscheidung:** v2 nimmt `'app'` (mcp-approval2-Wire), NICHT `'app_state'`.

Begruendung: `packages/adapters/src/knowledge/types.ts:21` definiert die Wire-Shape mit `'app'`. PWA-Proxy in `apps/server/src/routes/knowledge-proxy.ts:36` und KnowledgeService kennen nur `'app'`. v1's `'app_state'` ist intern in `/workspaces/mcp-knowledge/migrations/0001_objects.sql:21` — diese DB wird leer (kein Datenimport, §10.3). Der Rename ist also ein Plain-Text-Find-Replace im Port von `objects/api.ts` und allen 17 apps-Tools.

**Subtype-Konvention** (kanonisch in v2):
- `kind='app', subtype='shopping_list'` — composable-app state envelope.
- `kind='app', subtype='checklist'` — generischer checklist-block-host.
- `kind='app', subtype='manifest'` — Layout-Definition (LAYOUT-doc separate, falls je ueber-1:1 split).
- `kind='doc', subtype='pdf' | 'md' | 'image' | null`.
- `kind='skill', subtype=null` (skill kind hat keinen subtype).
- `kind='memo', subtype=<scope>` (z.B. `'personal' | 'project' | 'work'`).

**Schema-Validation:** zod-Enum `z.enum(['doc','skill','app','memo'])` an der HTTP-Boundary in `routes/objects.ts`. Drizzle-Spalte ist `text` mit CHECK-Constraint — fail-fast bei Migrations-Bugs.

### 4.2 Native `object_refs` + `object_tags` Routes (C2)

**Entscheidung: Option A — v2 implementiert refs+tags als first-class Tabellen + HTTP-Routes.** Der heutige `meta.resource_ids`-Workaround in `apps/server/src/services/knowledge.ts:150-273` wird abgeloest sobald v2 in Production ist.

Begruendung: drei Surfaces (`attachDocToSkill`, `docUsages`, `readSkillResource`, `bulkDelete`-refcount) operieren heute client-side ueber `listObjects(kind='skill', limit=200)`-Pagination. Bei >200 Skills ist das O(n) und scharfe Race-Conditions beim Cross-Update zweier Skills (kein optimistic-CAS auf der Beziehung). Native Routes mit DB-Constraints sind:
- FTS-fuer-incoming-refs O(1) statt O(n)
- atomic-attach (insert-on-conflict-do-nothing)
- refcount-trigger in DB statt application-level
- Sub-Doc-Annotation in `search` (PLAN-search-subdocs aus v1) wieder moeglich ohne 1k-Skills-Scan

Aufwand: 4-6h zusaetzlich gegenueber Workaround-Erhalt. Code-Reduction in mcp-approval2 nach Cutover: ~120 Zeilen weniger in `services/knowledge.ts` (3 Wrapper-Methoden werden trivial-Adapter-Calls).

**Drizzle-Schema** (`apps/knowledge/src/lib/schema.ts`):

```typescript
export const objectRefs = pgTable('object_refs', {
  id: text('id').primaryKey(), // ULID
  ownerId: text('owner_id').notNull(),
  fromId: text('from_id').notNull().references(() => objects.id, { onDelete: 'cascade' }),
  toId: text('to_id').notNull().references(() => objects.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // 'skill_resource' | 'app_attachment' | future
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => ({
  uniqRefByRole: uniqueIndex('uniq_refs_from_to_role').on(t.fromId, t.toId, t.role),
  byTo: index('idx_refs_to_role').on(t.toId, t.role),
  byOwner: index('idx_refs_owner').on(t.ownerId),
}));

export const objectTags = pgTable('object_tags', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  objectId: text('object_id').notNull().references(() => objects.id, { onDelete: 'cascade' }),
  tag: text('tag').notNull(), // 'group:cooking', 'priority:high', ...
  source: text('source').notNull().default('user'), // 'user' | 'system' | 'inferred'
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => ({
  uniqTag: uniqueIndex('uniq_tags_object_tag').on(t.objectId, t.tag),
  byTag: index('idx_tags_tag').on(t.tag),
}));
```

**HTTP-Routes** (alle JWT-protected, sub=userId):

| Route | Body / Query | Response |
|---|---|---|
| `POST /v1/refs` | `{from_id, to_id, role}` | `{ref: RefView}` |
| `DELETE /v1/refs/:ref_id` | — | `204` |
| `GET /v1/objects/:id/refs?direction=incoming\|outgoing\|both&role?=` | — | `{incoming: RefView[], outgoing: RefView[]}` |
| `POST /v1/tags` | `{object_id, tag, source?}` | `{tag: TagView}` |
| `DELETE /v1/tags/:tag_id` | — | `204` |
| `GET /v1/objects/:id/tags` | — | `{tags: TagView[]}` |

**Migration-Strategie in mcp-approval2**: nach Cutover (knowledge2 mit refs/tags-Routes live) — `services/knowledge.ts` `attachDocToSkill/docUsages/readSkillResource` umstellen auf `adapter.createRef(...)` / `adapter.listRefs(...)`. `meta.resource_ids` bleibt eine kurze Zeit als read-fallback fuer evtl. importierte v1-Daten, danach wird der Lesepfad entfernt. Adapter-Surface `KnowledgeAdapter` braucht 4 neue Methoden: `createRef, deleteRef, listRefs, createTag, deleteTag, listTags` — Cross-Service-Contract Update D-13/D-14/D-15.

**Migrations-Files:**
- `0001_objects.sql` — objects + tsvector + pgvector
- `0002_refs_tags.sql` — object_refs + object_tags
- `0003_uploads_idem.sql` — uploads + idempotency_keys + audit_log

### 4.3 Multi-Kind-Search (D-9, H4)

**Entscheidung:** v2 implementiert `kind: ObjectKind | ObjectKind[] | undefined` server-side. Greenfield-Recht.

**Wire-Shape** (`POST /v1/search`):

```json
{
  "query": "shopping list eggs",
  "kinds": ["doc", "skill"],         // optional, fehlt = alle 4
  "subtypes": ["pdf", null],         // optional, pro kind oder global
  "tags": ["group:cooking"],         // optional, AND-matched
  "limit": 20,
  "offset": 0
}
```

Server-side zod:

```typescript
const SearchSchema = z.object({
  query: z.string().min(1).max(500),
  kinds: z.array(z.enum(['doc','skill','app','memo'])).optional(),
  subtypes: z.array(z.string().nullable()).optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});
```

RRF-Fusion bleibt per-kind (separate CTE pro kind, dann fusion). `HttpKnowledgeAdapter` in `packages/adapters` sendet heute schon multi-kind forward-compatible — der server-side handler in v2 schliesst D-9.

**Sub-Doc-Annotation** (`used_by[]`): wenn `kinds` `'doc'` enthaelt, fuegt der Handler fuer jeden doc-Hit eine `used_by[]`-Liste aus `object_refs WHERE to_id = doc.id AND role='skill_resource'` (max 2 + truncated_count). Funktioniert weil refs nativ sind (§4.2).

---

## 5. Storage-Layer-Konkretisierung

### 5.1 pgvector + Konsistenz-Modell (H5)

**Schema** (`migrations/0001_objects.sql`):

```sql
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE objects ADD COLUMN embedding vector(768);
CREATE INDEX idx_objects_embedding_hnsw
  ON objects USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

ALTER TABLE objects ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(description, '')), 'B') ||
  setweight(to_tsvector('simple', coalesce(keywords_text, '')), 'C')
) STORED;
CREATE INDEX idx_objects_tsv ON objects USING gin(tsv);
```

**Konsistenz-Modell (strong-consistent, KEIN D1-Mirror):**

v1 hatte `objects.embedding_blob BLOB` als D1-Mirror neben Vectorize weil Vectorize eventually-consistent ist (5-30 min Lag, siehe [feedback_vectorize_eventual_consistency.md](https://github.com/axel-rogg/mcp-approval/blob/main/.claude/memory/feedback_vectorize_eventual_consistency.md)). pgvector ist **strong-consistent** — INSERT mit embedding-column ist sofort fuer SELECT sichtbar. Konsequenz fuer v2:

- **Kein D1-Mirror noetig.** Embedding lebt ausschliesslich in der `objects.embedding`-Spalte. Spart eine Tabelle und einen Sync-Pfad.
- **Konsistenz-Bonus dokumentiert:** Callers aus v1 die "warte auf Vectorize-Propagation" workarounds hatten (z.B. retry-on-empty-search) sind in v2 unnoetig. Cross-link zu mcp-approval-Memory `feedback_vectorize_eventual_consistency` — beim ersten v2-Smoke-Test ist Re-Read sofort frisch.
- **Trade-off:** HNSW-Index-Insert ist synchron mit dem INSERT → +5-15 ms Insert-Latenz (gemessen p95 fuer 768-dim Vector + m=16). Akzeptabel — Pilot schreibt <10 docs/Tag.
- **Falls Insert-Last steigt** (>100/min): IVFFlat statt HNSW reduziert Build-Time, kostet Recall. Tuning-Hebel fuer Phase 3+.

**Dimension 768** (Vertex `text-embedding-005`). Pilot leer → keine Migration.

### 5.2 Hetzner Object Storage als S3-Backend

**Endpoint:** `https://fsn1.your-objectstorage.com` (offiziell S3v4-API). Bucket: `mcp-knowledge2-eu`. Region: `fsn1`.

**Doppler-Vars (neu, im `doppler-setup`-Modul):**
```
S3_ENDPOINT             = https://fsn1.your-objectstorage.com
S3_REGION               = fsn1
S3_BUCKET               = mcp-knowledge2-eu
S3_ACCESS_KEY_ID        = <Hetzner-Object-Storage-User-Access-Key>
S3_SECRET_ACCESS_KEY    = <Hetzner-Object-Storage-User-Secret>
S3_FORCE_PATH_STYLE     = true
```

**Kein Sharing mit Terraform-State** — TF-State bleibt auf R2 (Cloudflare). Hetzner-S3-Creds sind eigene Doppler-Vars.

**`S3BlobAdapter`** in `packages/adapters/src/blob/s3.ts` unterstuetzt `endpoint`-Override + `forcePathStyle` — verifiziert kompatibel. Kein Adapter-Patch noetig.

**Schluessel-Konvention:**

| Prefix | Owner | Zweck |
|---|---|---|
| `objects/<ULID>` | `apps/knowledge/src/objects/api.ts` | Body-Overflow `>16 KB` |
| `objects/<ULID>@v<n>` | `objects/api.ts` | Revision-Overflow |
| `backup/<ts>.bin` | `apps/knowledge/src/cron/backup.ts` | Wochen-Backup (encrypted) |
| `uploads/<upload_id>` | `apps/knowledge/src/uploads/api.ts` | Pre-signed Upload-Buffer (12h-TTL via lifecycle-rule) |

`S3_KEY_REGEX = /^(objects|uploads|backup)\//` als Defense-in-depth (Audit-H12).

### 5.3 KEK-Ref-Form + Multi-User-Migrationspfad (H3)

**Pilot (Single-Tenant):** `vault://transit/keys/knowledge2`. Ein globaler KEK fuer alle objects-DEKs.

**Format:** matched `REF_PATTERN` aus `packages/adapters/src/kek/openbao.ts:113` — `vault://<mount>/keys/<keyName>`. mcp-approval2 nutzt `user-<userId>` per-User; knowledge2 nutzt initial `knowledge2` (eine Konstante) weil:
- Single-user-Pilot — Compromise-Window ist `1 User`, nicht `N User`.
- Service-Boundary ist die Trust-Linie (KEK von mcp-approval2 darf knowledge2-Daten nicht entschluesseln und vice versa).

**Multi-User-Cutover-Pfad** (Phase 3+, kein neuer Plan-File noetig):
1. Migration `00xx_per_user_kek.sql` fuegt Spalte `objects.kek_ref TEXT NOT NULL DEFAULT 'vault://transit/keys/knowledge2'` hinzu.
2. Re-Wrap-Loop: pro neu auftauchendem userId (`sub` im JWT) → OpenBao `transit/keys/knowledge2-user-<userId>` anlegen → DEK-Re-Wrap aller objects mit `owner_id=userId` → `kek_ref` auf neuen Pfad setzen.
3. Code-Aenderung `objects/api.ts`: bei encrypt `kek.wrap(plainKey, {kekRef: row.kek_ref})`. KekProvider-Interface unterstuetzt das schon (`OpenBaoKekProvider.wrap()` nimmt ref-Override).
4. Aufwand ~4-6h. Nicht im Pilot-Scope.

**Q9 (neu, vom Reviewer):** beantwortet — Pilot global, Migrations-Pfad oben dokumentiert.

---

## 6. Crypto-Reuse + AAD-Konvention (H1)

### 6.1 Entscheidung: knowledge2-lokales AAD-Modul

`apps/knowledge/src/lib/aad.ts` mit den vier knowledge-spezifischen RecordTypes — Reuse von `@mcp-approval2/core/crypto`'s `aesgcm`-Helper (verschluesseln/entschluesseln) ABER eigenes AAD-Helper-Modul.

Begruendung: v1 nutzt vier RecordTypes (`objects`, `objects-desc`, `objects-produced-for`, `objects-quality`) — siehe `mcp-knowledge/migrations/0001_objects.sql:7-11`. `packages/core/src/crypto/aad.ts:19` exportiert nur `'credentials' | 'session' | 'audit' | 'object' | 'generic'`. Drei Optionen waren:

| Option | Pro | Kontra |
|---|---|---|
| A: core/aad.ts erweitern (4 neue Types) | Single-Source | Cross-cuts mcp-approval2-Tests, AAD-Builder-Schema-Bruch |
| **B: knowledge2-lokales AAD-Modul** | Service-Boundary auch in Crypto, Test-Risiko = 0 | Mini-Code-Duplikation (~30 LOC) |
| C: AAD-Pattern komplett vereinheitlichen (`recordType='knowledge-objects'`, sub-discriminator via field) | Sauberster Modell-Schnitt | bricht v1-Backups falls je migriert |

**Gewaehlt: B.** Service-Boundary in Crypto ist konsistent mit der HTTP-Boundary. Keine Cross-Service-Test-Aenderungen. v1-Daten muessen nicht migriert werden (Pilot leer, §10.3). Bei spaeterem Wunsch zu unifizieren bleibt der Path B → A trivial (build-helpers identisch).

**`apps/knowledge/src/lib/aad.ts`:**

```typescript
export type KnowledgeAadRecordType =
  | 'objects'              // body ciphertext
  | 'objects-desc'         // description (encrypted summary, PLAN-docs-embedding)
  | 'objects-produced-for' // quality-gate provenance
  | 'objects-quality';     // quality-report ciphertext

export interface KnowledgeAadInput {
  recordType: KnowledgeAadRecordType;
  ownerId: string;
  kind: 'doc' | 'skill' | 'app' | 'memo';
  subtype: string | null;
  objectId: string;
}

export function buildKnowledgeAad(input: KnowledgeAadInput): string {
  const subtype = input.subtype ?? '';
  // Format: <recordType>|<owner>|<kind>:<subtype>|<id>
  // — recordType-Prefix verhindert Cross-Record-Replay
  // — kind:subtype-Section ist identisch zu v1-AAD (post-tool-collapse)
  return `${input.recordType}|${input.ownerId}|${input.kind}:${subtype}|${input.objectId}`;
}
```

**Encrypt/Decrypt-Pfad:** `aesgcmEncrypt({plaintext, key, aad: aadBytes(buildKnowledgeAad({...}))})` — die `aesgcm`-Funktion + `aadBytes`-Helper kommen weiterhin direkt aus `@mcp-approval2/core/crypto` (Reuse). Nur der AAD-String-Builder ist knowledge2-lokal.

**Test-Coverage:** `apps/knowledge/tests/aad.test.ts` snapshotet alle 4 AAD-Variants gegen bekannte Inputs. Bei Schema-Bruch failt der Snapshot.

---

## 7. Env-Var-Schema (zod, konsistent mit mcp-approval2)

Konvention: `translateBootEnv()` mappt Compose-File-Aliases auf zod-Schema-Namen — der App-Code sieht IMMER den Schema-Namen.

### 7.1 Schema (`apps/knowledge/src/lib/config.ts`)

```typescript
const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  ORIGIN: z.string().url().default('http://localhost:8788'),

  DATABASE_URL: z.string().min(1),
  DATABASE_DIALECT: z.enum(['postgres', 'sqlite']).default('postgres'),

  // Auth
  JWKS_URL: z.string().url(),
  JWT_ISSUER: z.string().default('mcp-approval2'),
  JWT_AUDIENCE: z.string().default('mcp-knowledge2'),
  MCP_APPROVAL_INTERNAL_TOKEN: z.string().min(32),
  MCP_APPROVAL_BASE_URL: z.string().url(),

  // Blob
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),

  // KEK
  VAULT_ADDR: z.string().url(),
  VAULT_TOKEN: z.string().min(1),
  VAULT_TRANSIT_PATH: z.string().default('transit'),
  VAULT_TRANSIT_KEY: z.string().default('knowledge2'),

  // AI (Vertex EU) — KANONISCHE Namen aligned mit mcp-approval2 (H2)
  VERTEX_AI_PROJECT_ID: z.string().optional(),
  VERTEX_AI_REGION: z.string().default('europe-west4'),
  VERTEX_AI_EMBED_MODEL: z.string().default('text-embedding-005'),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),

  KNOWLEDGE_BACKUP_MASTER_KEY_BASE64: z.string().optional(),

  QUALITY_GATE_ENABLED: z.coerce.boolean().default(false),
  QUALITY_GATE_DAILY_USD: z.coerce.number().default(2.0),
  QUALITY_GATE_JUDGE_TIMEOUT_MS: z.coerce.number().default(30_000),
  QUALITY_GATE_JUDGE_MODEL: z.string().default('gemini-2.5-flash'),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});
```

### 7.2 Vertex-Naming-Konsolidierung (H2)

**Heute** (`deploy/hetzner/docker-compose.yml` Z.155-156):
```yaml
VERTEX_REGION: ${VERTEX_AI_REGION:-europe-west4}
VERTEX_PROJECT_ID: ${VERTEX_AI_PROJECT_ID:-}
```

**Aenderung:** Umbenennen auf kanonisches Schema (siehe mcp-approval2-Block Z.122):
```yaml
VERTEX_AI_REGION: ${VERTEX_AI_REGION:-europe-west4}
VERTEX_AI_PROJECT_ID: ${VERTEX_AI_PROJECT_ID:-}
```

`translateBootEnv()` in `apps/knowledge/src/index.ts` akzeptiert BC-Alias `VERTEX_REGION` → `VERTEX_AI_REGION` waehrend einer 1-Sprint-Uebergangszeit, dann hart entfernen. Gleiches Pattern fuer `VERTEX_PROJECT_ID` → `VERTEX_AI_PROJECT_ID` und `BACKUP_MASTER_KEY` → `KNOWLEDGE_BACKUP_MASTER_KEY_BASE64`.

**Risiko ohne Umbenennung:** zod-default `europe-west4` greift, aber das ist Glueck. Bei einem Doppler-Override (z.B. fuer US-Test-Region) silently die falsche Region — kein Vertrag.

### 7.3 Service-Token-Rotation (M2)

`MCP_APPROVAL_INTERNAL_TOKEN` ist shared zwischen mcp-approval2 und mcp-knowledge2. Cadence: **90 Tage** (analog CF-Access in CLAUDE.md). Rotation-Steps:
1. Doppler: neuen Token generieren (`openssl rand -hex 32`).
2. Beide Container restarten in einer Maintenance-Window (5 min Downtime).
3. Falls die Aktion in `/v1/internal/erase-user` mitten in einer Rotation laeuft — sie schlaegt fehl (no-token), Operator-Retry nach Restart.

Cadence-Reminder im selben Doppler-Lifecycle wie CF-Access-Service-Token (User-Profile-Cron).

---

## 8. Auth-Pfad

### 8.1 RS256-JWT von mcp-approval2 + JWKS-Preflight (M3)

- JWKS-Endpoint: `http://mcp-approval2:8787/.well-known/jwks.json` (internal-network) bzw. `https://mcp2.ai-toolhub.org/.well-known/jwks.json` (extern).
- mcp-knowledge2 zieht JWKS via `jose.createRemoteJWKSet(new URL(JWKS_URL))` — cached + retried bei einzelnen Requests automatisch.
- Pro Request: `Authorization: Bearer <jwt>`, validation, `sub` = `userId` (UUID).

**Boot-Preflight `waitForApprovalJwks()`:**

```typescript
async function waitForApprovalJwks(env: Env): Promise<void> {
  const url = env.JWKS_URL;
  const budgetMs = 30_000;
  const deadline = Date.now() + budgetMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) {
        const json = await res.json() as { keys?: unknown[] };
        if (Array.isArray(json.keys) && json.keys.length > 0) {
          log.info({ url, attempt }, 'jwks reachable');
          return;
        }
      }
    } catch (err) {
      log.debug({ url, attempt, err: errorMessage(err) }, 'jwks not ready');
    }
    attempt += 1;
    await sleep(2000);
  }
  throw new Error(`waitForApprovalJwks: ${url} not reachable within ${budgetMs}ms`);
}
```

Aufruf-Reihenfolge in `apps/knowledge/src/index.ts:main()`:

```typescript
const env = translateBootEnv(process.env);
const config = ConfigSchema.parse(env);
await waitForDb(config);
await waitForVault(config);
await waitForApprovalJwks(config);  // NEU
const app = createApp({config, ...adapters});
app.listen(config.PORT);
```

`waitForDb()` + `waitForVault()` Pattern 1:1 aus `apps/server/src/index.ts:214` und folgenden Zeilen — wir kopieren die Helper.

### 8.2 Bearer-Service-Token fuer Internal-Routes

`/v1/internal/erase-user` (D-10): statischer `MCP_APPROVAL_INTERNAL_TOKEN` als Bearer, NICHT user-JWT. `apps/knowledge/src/auth/bearer.ts`:

```typescript
export function checkServiceBearer(req: Request, env: Env): boolean {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  return timingSafeEqual(token, env.MCP_APPROVAL_INTERNAL_TOKEN);
}
```

Smoke + Health-Check brauchen keinen Token.

### 8.3 Kein Cookie-Pfad

mcp-knowledge2 ist headless. Aufrufe von mcp-approval2 (JWT) oder GH-Action-Smoke (Service-Token). Kein Set-Cookie, keine CSRF-Schicht.

---

## 9. Tool-Surface (Mapping CF Worker → v2)

### 9.1 Bestand + v2-Behandlung

| Familie | # Tools | v2-Behandlung |
|---|---|---|
| `core.ts` | 12 | direkt auf REST + MCP-Adapter |
| `docs/*` | 8 | trivial Port — `embed: true` → `aiAdapter.embed()` (Dim-Wechsel 1024→768) |
| `skills/*` | 15 | trivial Port; `attach_resource` nutzt native `/v1/refs` (§4.2) |
| `memorize/*` | 6 | trivial Port; embed_helper auf AiAdapter |
| `apps/*` | 17 | trivial Port — Rename `'app_state'` → `'app'` (§4.1) |
| `objects/*` | 1 (`bulk_delete`) | trivial; refcount via DB-Trigger statt application |
| `search.ts` | 1 | rewrite auf pgvector RRF + multi-kind (§4.3) |
| `quality/*` | 4 | AiAdapter ersetzt AI-Gateway-Slug |

Insgesamt ~64 Tools — Surface bleibt 1:1, **kein Tool-Cut**. Schema-Aenderungen:
- `docs.put.embed=true` Dimension 768
- `search` akzeptiert `kinds: ObjectKind[]` (D-9 endlich resolved)
- `skills.attach_resource` returnt jetzt eine `ref_id` (vorher mutated meta)

### 9.2 MCP-Adapter Reuse

`mcp-knowledge/src/routes/mcp.ts` + `tools/registry.ts` sind plain-TS, kein CF-spezifischer-API-Call. 1:1 portieren in `apps/knowledge/src/routes/mcp.ts`.

---

## 10. Migration-Path

### 10.1 CF-Production unberuehrt

`/workspaces/mcp-knowledge` (Production `knowledge.ai-toolhub.org`) bleibt aktiv bis mcp-approval Sunset. Daten in R2/D1 sind 1-Monats-Archiv.

### 10.2 Cross-Service-Contract-Updates

Aus dem v2-Modell ergeben sich neue Drift-Entries fuer `docs/CROSS-SERVICE-CONTRACT-RESOLUTION.md`:

| Drift | Aenderung |
|---|---|
| D-9 | resolved — server-side multi-kind ist live |
| D-13 (NEU) | `KnowledgeAdapter.createRef/deleteRef/listRefs` — Adapter-Erweiterung |
| D-14 (NEU) | `KnowledgeAdapter.createTag/deleteTag/listTags` — Adapter-Erweiterung |
| D-15 (NEU) | `attachDocToSkill` migrates from `meta.resource_ids` → `createRef(role='skill_resource')`; 1-Sprint-Read-Fallback fuer evtl. v1-Daten |

mcp-approval2's `KnowledgeService` wird in einem Folge-PR nach v2-Live umgebaut — `services/knowledge.ts:150-273` werden trivial-Adapter-Calls.

### 10.3 v2 startet leer

Pilot auf Hetzner ist Greenfield: leere `objects`-Tabelle, leerer S3-Bucket, leerer pgvector-Index, leeres refs/tags. Keine Datenmigration. Falls Bedarf: einmaliger `dump-from-cf.ts`-Skript in Phase-X.

---

## 11. Build + Deploy

### 11.1 Dockerfile (`apps/knowledge/Dockerfile`)

Pattern 1:1 wie `deploy/fly/Dockerfile.server`: 4-Stage Build, runtime mit `apps/knowledge/dist` + migrations + scripts. HEALTHCHECK `wget /health`.

Image-Tag: `ghcr.io/axel-rogg/mcp-knowledge2:latest` (Q1: behalten — compose-Refactor unnoetig).

### 11.2 Migrations

`apps/knowledge/scripts/migrate.ts` 1:1 wie `apps/server/scripts/migrate.ts`. Dediziertes `mcp-knowledge2-migrate` compose-service mit `restart: "no"` der einmal laeuft.

### 11.3 Compose-Service-Wiring

Aenderungen an `deploy/hetzner/docker-compose.yml` Z.143-173:
- `environment`: Vertex-Vars umbenennen `VERTEX_REGION` → `VERTEX_AI_REGION`, `VERTEX_PROJECT_ID` → `VERTEX_AI_PROJECT_ID`, `BACKUP_MASTER_KEY` → `KNOWLEDGE_BACKUP_MASTER_KEY_BASE64` (H2).
- Neu hinzufuegen: `S3_*` (5 Vars), `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_TRANSIT_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `ORIGIN`.
- `volumes`: mount `vertex-sa.json:ro` shared.
- `depends_on`: postgres (healthy) + openbao (started) + mcp-approval2 (started) — mcp-approval2 `waitForApprovalJwks()` interner Boot-Preflight gleicht den weichen `service_started` aus.

**postgres-init.sql:** schon angepasst (Bestand: `CREATE DATABASE knowledge2;` Z.11 + `CREATE EXTENSION vector;` Z.19+24 in beiden DBs). **Bullet aus v1-Plan §10.3 gestrichen** (M1).

### 11.4 Doppler-Placeholder

Anzuhaengen in `terraform/modules/doppler-setup/main.tf` (alle mit `ignore_changes = [value]`):

```
S3_ENDPOINT             (Default: https://fsn1.your-objectstorage.com)
S3_REGION               (Default: fsn1)
S3_BUCKET               (Default: mcp-knowledge2-eu)
S3_ACCESS_KEY_ID        (User manuell)
S3_SECRET_ACCESS_KEY    (User manuell)
S3_FORCE_PATH_STYLE     (Default: true)
KNOWLEDGE_TAG           (Default: latest)
```

`KNOWLEDGE_BACKUP_MASTER_KEY_BASE64`, `VAULT_TOKEN`, `VERTEX_AI_*`, `MCP_APPROVAL_INTERNAL_TOKEN`, `POSTGRES_PASSWORD` schon vorhanden.

### 11.5 Caddyfile

```
{$DOMAIN_KNOWLEDGE} {
  reverse_proxy mcp-knowledge2:8788
}
```

Doppler-Var `DOMAIN_KNOWLEDGE` (Default `knowledge2.ai-toolhub.org`) existiert.

---

## 12. Risiken + Offene Fragen

### 12.1 Risiken

| Risiko | Wahrscheinlichkeit | Mitigation |
|---|---|---|
| pgvector hnsw-Index blow-up bei vielen embeds | niedrig (Pilot ~1k objects) | Index-Tuning `m=8`; IVFFlat als Fallback |
| Vertex Free-Tier-Quota hit | mittel | Quota-Hook + retry-backoff; cached embed bei Quota-Exhaust |
| OpenBao Boot-Race | hoch | `waitForVault()` 60s-Budget |
| **JWKS-Pull-Race bei Cold-Boot** (M3) | mittel | **`waitForApprovalJwks()`-Preflight, §8.1** |
| Hetzner Object Storage Latenz schlechter als R2 | mittel | single-region (fsn1, gleicher VM-Standort), p95 <50ms erwartet |
| `idempotency_keys`-PG-Tabelle hot | niedrig | Index auf `(key)` + hourly cleanup |
| Cross-Service-Contract-Drift bei Schema-Aenderungen | mittel | `apps/knowledge/tests/contract.test.ts` snapshots OpenAPI |
| Migration der CF Worker-AI 1024-dim Vectors | niedrig (Pilot leer) | nicht migrieren; v2 startet leer |
| Adapter-Coupling (Direct-Import quer-rein) | hoch | ESLint `no-restricted-paths`; optional `dependency-cruiser`-Check |
| **refs/tags-Migration in mcp-approval2 verzoegert** (C2-Follow-Up) | mittel | `meta.resource_ids` als read-fallback fuer 1 Sprint, dann hart entfernen |

### 12.2 Offene Fragen — User-Entscheidung

| Q | Frage | Default-Vorschlag |
|---|---|---|
| Q1 | Image-Tag-Naming | behalten (`ghcr.io/axel-rogg/mcp-knowledge2`) |
| Q2 | Crypto-Reuse mit `@mcp-approval2/core`? | **Reuse + lokales AAD-Modul** (§6, gewaehlt B) |
| Q3 | Embedding-Dim 768 oder 1024? | **768** (Vertex `text-embedding-005`) |
| Q4 | Idempotency PG oder Redis? | **PG** (kein zusaetzlicher Container) |
| Q5 | Cron-Engine? | **`node-cron` Phase 1**, `pg-boss` Phase 3 wenn Job-Vielfalt waechst |
| Q6 | Uploads HMAC oder presigned-PUT? | **`@aws-sdk/s3-request-presigner`** (Drop Custom-HMAC) |
| Q7 | Sharing-Layer | schon entschieden (PLAN-architecture-v1 §2.1) |
| Q8 | TF-State-Backend bei R2 belassen? | **ja** (CLAUDE.md Infrastructure-Policy explizit) |
| Q9 | KEK-Ref-Form Multi-User-Future | **Pilot global `knowledge2`, Cutover-Pfad §5.3** |
| Q10 | refs/tags native vs. meta-only | **native (§4.2 Option A)** |

---

## 13. Implementation-Sequenz

**Schaetzung Vollzeit-Stunden:** Single-Engineer (Axel), 6-7 Wochen Wall-Time bei 30h/Woche fokussiert. Mit den Klarstellungen aus v2: +4-6h fuer native refs/tags (§4.2), +2h fuer waitForApprovalJwks + Preflight-Test (§8.1), +1h fuer Vertex-Env-Rename (§7.2), +2h fuer lokales AAD-Modul + Snapshot-Test (§6). Netto-Mehraufwand ~10h gegenueber v1-Plan.

### Phase 0 — Setup (4-6 h)
- `apps/knowledge/`-Skeleton, package.json, tsconfig, vitest, biome.json
- `npm install -w @mcp-approval2/knowledge`
- ESLint `no-restricted-paths` zwischen `apps/server/**` und `apps/knowledge/**`
- Smoke `npm run typecheck` mit leerem `src/index.ts`-Stub
- Review-Brief abgelegt in `docs/reviews/` (Audit-Trail)

### Phase 1 — DB + Migrations + Adapter-Wiring (12-16 h)
- Drizzle-Schema: objects + object_refs + object_tags + object_revisions + uploads + idempotency_keys + audit_log
- `migrations/0001_objects.sql` (Postgres-Variant inkl. pgvector + tsvector)
- `migrations/0002_refs_tags.sql` (§4.2 — native Routes-Backing)
- `migrations/0003_uploads_idem.sql`
- `scripts/migrate.ts` + `scripts/health-check.ts`
- `src/lib/config.ts` (zod) + `src/lib/db.ts` (createDbAdapter) + `src/lib/aad.ts` (§6)
- `src/app-factory.ts` mit `createApp({config, db, blob, kek, ai})`
- `src/index.ts` mit `translateBootEnv()` + `waitForDb()` + `waitForVault()` + `waitForApprovalJwks()` (§8.1)
- Compose-Update Vertex-Vars-Rename + S3-Vars + VAULT-Vars

### Phase 2 — Auth + Health (4-6 h)
- `src/auth/jwks.ts` (port + `jose.createRemoteJWKSet`)
- `src/auth/jwt.ts` + `src/auth/bearer.ts` (timingSafeEqual)
- `src/routes/health.ts` (GET /health, /version, /.well-known/health)
- Port `jwt-signing.ts`-Stub-Generator fuer Test-Fixtures (M5)
- Vitest: JWT-Validation gegen Stub-JWKS + `waitForApprovalJwks`-retry-loop-test

### Phase 3 — Objects-API + REST-Routes (16-20 h)
- Port `src/objects/api.ts` (CRUD + revisions) — D1→Drizzle, R2→BlobAdapter, KekProvider-Wrapper
- Native `src/refs/api.ts` + `src/tags/api.ts` (§4.2)
- Port `src/uploads/api.ts` — Hetzner-S3-presigned-PUT (`@aws-sdk/s3-request-presigner`)
- REST-Handler: `src/routes/{objects,refs,tags,shares,uploads,internal}.ts`
- Idempotency-Middleware (PG-backed)
- Vitest-Suite: CRUD + refs + tags + share-CRUD + eraseUser (Service-Token) + Bulk-Delete + CAS-Conflict
- Contract-Test gegen `HttpKnowledgeAdapter` (in-process spinup beider Services)

### Phase 4 — Search + Embeddings (8-12 h)
- `src/embed/vertex.ts` — wrapper um `aiAdapter.embed()` mit PII-mask + 8k-char-Limit
- `src/search/hybrid.ts` — RRF-Fusion-Query, multi-kind (§4.3)
- `src/routes/search.ts` — zod-Schema `kinds: ObjectKind[]`
- Vitest: hybrid-search relevance-smoke + multi-kind smoke

### Phase 5 — MCP-Adapter + Tool-Surface (16-20 h)
- Port `src/mcp/registry.ts` + `src/routes/mcp.ts`
- Per-Familie Tool-Slices: docs, skills, memorize, apps, objects, search, quality (60+ Tools)
- Rename `'app_state'` → `'app'` in 17 apps-Tools (§4.1)
- `apps/blocks/*` (22 blocks) trivial port
- Vitest: tools/list (count + shape), tools/call smoke (1 per Familie)

### Phase 6 — Quality-Gate + Apps-State + Pilot-Smoke (6-10 h)
- Quality-Gate: `apps/knowledge/src/quality/{judge,rubric}.ts`
- Apps-State-Layer (api.ts, types_registry, legacy_to_layout)
- Composable-Apps-Tests aus CF-Repo portieren
- Pilot-Smoke `scripts/pilot-smoke-knowledge.sh`
- Cron in-process (node-cron) fuer uploads-sweep + uploads-purge + weekly-backup

### Phase 7 — Deploy + Hetzner-Cutover (8-12 h)
- Dockerfile + GHCR-build-action
- Compose-Update + Caddyfile-vhost
- Doppler-Placeholders
- Terraform: Hetzner-Object-Storage-Bucket + Cloudflare-DNS fuer `knowledge2.ai-toolhub.org`
- Initial-Deploy + smoke; Watchtower picked up label
- Review-Brief Phase 7 → `docs/reviews/`

**Phase 0-6: ~70-100h Dev. Phase 7: 8-12h.** Realistisch 5-6 Wochen bei 30h/Woche.

---

## 14. Review-Response-Log

| Finding | Entscheidung | Begruendung | Geaenderte Sektion(en) |
|---|---|---|---|
| **C1 ObjectKind-Mismatch** | v2 nimmt `'app'` (mcp-approval2-Wire) | `packages/adapters/src/knowledge/types.ts:21` definiert Wire mit `'app'`, PWA-Proxy + Service kennen nur das. v1-DB wird leer (Greenfield) → Rename ist Plain-Text-Find-Replace, kein Migration-Cost. | §3 Port-Inventur, §4.1 (komplett neu), §9.1 |
| **C2 refs+tags-Modell** | Option A: native Tabellen + HTTP-Routes | Heutiger `meta.resource_ids`-Workaround ist O(n)-Scan + race-prone, native gibt atomic-attach + Sub-Doc-Annotation gratis. 4-6h Mehraufwand fuer ~120 LOC Reduction in mcp-approval2 nach Cutover. | §3 Port-Inventur, §4.2 (komplett neu), §9.1, §10.2 (D-13/14/15) |
| **H1 AAD-RecordTypes-Drift** | Option B: knowledge2-lokales AAD-Modul | core/aad.ts kennt nur 5 RecordTypes; v1 nutzt 4 spezielle (`objects`, `objects-desc`, `objects-produced-for`, `objects-quality`). Lokales Modul vermeidet Cross-Service-Test-Bruch + service-boundary Crypto-konsistent. | §6 (komplett neu), §3 Package-Struktur |
| **H2 Vertex-Region-Drift** | Kanonisches `VERTEX_AI_*`-Naming durchziehen | Compose Z.155-156 nutzt heute `VERTEX_REGION`/`VERTEX_PROJECT_ID`; mcp-approval2 nutzt `VERTEX_AI_*`. zod-default greift heute aus Glueck, kein Vertrag. BC-Alias 1 Sprint, dann hart entfernen. | §7.1, §7.2 (neu), §11.3 |
| **H3 KEK-Ref-Form Multi-User-Future** | Pilot global `knowledge2`, dokumentierter Migrations-Pfad zu `knowledge2-user-<userId>` | Single-tenant ok, Service-Boundary ist Trust-Linie. Re-Wrap-Loop ist 4-6h Phase 3+ ohne Datenverlust. | §5.3 (neu), §12.2 Q9 |
| **H4 D-9 Multi-Kind-Search** | Server-side `kinds: ObjectKind[]` zod-akzeptiert | Greenfield-Recht; HttpKnowledgeAdapter sendet bereits forward-compat. RRF per-kind, dann fusion. | §4.3 (neu), §9.1 |
| **H5 pgvector-Konsistenz-Modell** | Explizit dokumentiert: strong-consistent, kein D1-Mirror, +5-15ms Insert-Latenz | v1 hatte D1-Mirror wegen Vectorize-Eventual-Consistency; pgvector ist synchron. Konsistenz-Bonus muss in v2-Doku stehen sonst denkt ein Subagent man muss beides parallel halten. Cross-link zu `feedback_vectorize_eventual_consistency`. | §5.1 (neu) |
| **M1 postgres-init.sql** | Bullet gestrichen | Verifiziert: `deploy/hetzner/postgres-init.sql:11+19+24` createt schon DB + Extension. | §11.3 (Verweis "schon erledigt"), Phase 1 ohne Bullet |
| **M3 JWKS-Pull-Race** | `waitForApprovalJwks()`-Preflight analog `waitForDb()` | `createRemoteJWKSet` retried pro Request, aber erster Cold-Boot-Request kommt mit 503. 30s-Budget + 2s-Backoff aligned mit `waitForDb`. | §8.1 (neu), §12.1 Risiko, Phase 2 Bullet |

**Nicht-adressiert (Low-Severity, Reviewer-LOW + nicht-blocking):**
- L1 `KNOWLEDGE_TAG` default `latest` — nit, compose-Bestand. Keine Aenderung.
- L2 Estimate-Cross-Reference auf v1-Phasen-Bursts — Bullet im Sequenz-Header (§13).
- L3 ESLint vs `dependency-cruiser` — ESLint einfacher, beibehalten.
- L4 Vertex-DPA-Pruefung — Operations-Task, dem User vor Phase 7 zu confirmen. Nicht im Plan-Scope.
- M2 Token-Rotation-Cadence — §7.3 ergaenzt.
- M4 docs/reviews/-Dir — Phase 0 + Phase 7 Bullets in §13.
- M5 jwt-signing-Stub-Generator — Phase 2 Bullet in §13.

---

**Ende des Plans v2.** Begleitend zu pflegen: `docs/CROSS-SERVICE-CONTRACT-RESOLUTION.md` (D-13/14/15 nachreichen sobald native refs/tags-Routes live).
