# PLAN — mcp-knowledge2 v2 Architektur (Greenfield-Rewrite)

> **Status: ENTWURF (2026-05-14) — bereit fuer User-Review**
>
> Greenfield-Rewrite des Storage-Service knowledge-core (heute CF-Workers
> auf `knowledge.ai-toolhub.org`). Ziel: gleiche Ziel-Architektur wie
> mcp-approval2 — Hetzner-Pilot jetzt, GCP Cloud Run spaeter — und voll
> portabel via Adapter-Pattern.
>
> Schwester-Plan: [PLAN-architecture-v1.md](active/PLAN-architecture-v1.md)
> (mcp-approval2 Auth/Approval-Server).
>
> Konsolidierungs-Hinweis: `mcp-knowledge2` ist heute in `docker-compose.yml`
> Zeile 143ff. bereits referenziert als `ghcr.io/axel-rogg/mcp-knowledge2`,
> aber es gibt noch keinen Build hinter dem Image. Dieses Dokument ist die
> Baseline fuer den Build.

---

## 1. Zielarchitektur

**Hetzner-Phase (Pilot):**
- Postgres 16 mit `pgvector` (existing compose-service `postgres`, separate Datenbank `knowledge2`).
- Hetzner Object Storage als S3-Backend (`https://fsn1.your-objectstorage.com`, EU-Falkenstein).
- Vertex AI EU (`europe-west4`) fuer Embeddings (text-embedding-005, 768-dim) + optional Chat (Quality-Gate).
- OpenBao (compose-service `openbao`, Transit-Engine) als KEK-Provider. mcp-knowledge2 schreibt verschluesselt mit eigenem KEK-Namespace `vault://transit/keys/knowledge2`.
- JWKS-Pull von `https://mcp2.ai-toolhub.org/.well-known/jwks.json` zur RS256-JWT-Validation (sub=userId).

**GCP-Phase (Phase 2, kein Code-Refactor):**
- Cloud SQL Postgres mit `pgvector`-Extension.
- GCS-Bucket statt Hetzner Object Storage — gleicher `S3BlobAdapter`, anderer Endpoint + Auth.
- Vertex AI bleibt identisch (gleiche Region, gleiche Library).
- Cloud KMS statt OpenBao — neue `CloudKmsKekProvider`-Impl hinter `KekProvider`-Interface, Code im App-Layer unveraendert.

**Adapter-Pattern:** kein Cloudflare-Erbe im App-Daten-Pfad. Kein D1/R2/Vectorize/Workers-AI in `apps/knowledge/src/`. Adapter-Boundary identisch zu mcp-approval2 (`DbAdapter`, `BlobAdapter`, `KekProvider`, `AiAdapter`). Wechsel von Hetzner → GCP ist ein Doppler-Config + Compose-File-Tausch, kein `npm`-Diff.

---

## 2. Repo-Layout-Entscheidung

**Wahl: Option B — Monorepo-Erweiterung als `apps/knowledge/` in `/workspaces/mcp-approval2`.**

| Kriterium | A: eigenes Repo | B: `apps/knowledge/` im Monorepo |
|---|---|---|
| Adapter-Reuse | Kopie/published-package, driftet | Direkt `@mcp-approval2/adapters` — type-aligned |
| Core-Reuse (crypto/ULID) | Duplizieren oder pin | Direkt referenzieren |
| Cross-Service-Contract-Tests | Cross-Repo-Sync | Im Tree, Drift via tsc |
| CI / Deploy | Eigene Pipeline | Selbe Action, separater Build-Step |
| User-Workflow | Zwei Repos parallel | Ein `git pull` |
| Coupling-Risiko | niedrig (Service-Boundary forciert) | mittel — Mitigation: ESLint `no-restricted-paths` zwischen `apps/server/**` und `apps/knowledge/**` |

Constraint "gleiche Target-Architektur" ist nur ehrlich erreichbar wenn der Adapter-Code wirklich derselbe ist, nicht eine geforkte Kopie die driftet. Option A produziert zwei Vertex-/OpenBao-Adapter-Impls. Option B macht den Boundary HTTP-only und laesst Build-Code shared. Das alte CF-Worker-Repo `axel-rogg/mcp-knowledge` bleibt read-only bis Sunset (dann GH-Archive).

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
        ├── migrations/                # Drizzle SQL (Postgres-Variant der mcp-knowledge-Migrations)
        ├── scripts/                   # migrate.ts + health-check.ts (Pattern aus apps/server/scripts)
        ├── src/
        │   ├── index.ts               # Hono-Boot (translateBootEnv + waitForDb + waitForVault)
        │   ├── app-factory.ts         # createApp({config, db, blob, kek, ai})
        │   ├── lib/                   # config.ts (zod), db.ts (Postgres/SQLite-Switch), context.ts
        │   ├── auth/                  # jwks.ts (JWKS-pull), jwt.ts, bearer.ts (Service-Token)
        │   ├── routes/                # objects / shares / search / uploads / internal / mcp / health
        │   ├── objects/api.ts         # CRUD-Layer (port aus mcp-knowledge; R2→S3, D1→PG, Vec→pgvector)
        │   ├── search/hybrid.ts       # RRF (FTS-tsvector + pgvector)
        │   ├── embed/vertex.ts        # AiAdapter-call statt env.AI
        │   ├── pii/mask.ts            # 1:1 port
        │   ├── quality/               # judge.ts + rubric.ts — Vertex-Chat via AiAdapter
        │   ├── apps/api.ts            # composable-apps state-layer
        │   ├── skills/api.ts          # manifest + refs
        │   ├── mcp/                   # registry + per-Familie Tool-Slices
        │   ├── cron/                  # Phase-1: node-cron in-process; Phase-3: pg-boss
        │   └── middleware/            # idempotency (PG-backed) + audit
        └── tests/                     # vitest
```

### Port-Inventur

**1:1 portierbar (trivial):** `src/crypto/*` (oder direkt `@mcp-approval2/core/crypto` — siehe Q2), `src/pii/mask.ts`, `src/ulid.ts` (in core schon vorhanden — drop), `src/search/scorers.ts`, `src/apps/blocks/*` (22 blocks Schema-Defs), `src/util/*`.

**Mittlerer Port-Aufwand:** `src/quality/{judge,rubric}.ts` (AI-Gateway-Slug → `aiAdapter.chat()`), `src/apps/{types,types_registry,legacy_to_layout,action_router}` (objects-API-coupling), `src/middleware/idempotency.ts` (KV → PG-Tabelle).

**Adapter-Umweg pflicht:**

| CF-Concept | v2-Mapping |
|---|---|
| `env.DB` (D1) | `db.scoped(userId)` + Drizzle |
| `env.R2` | `blob.put/get` (S3BlobAdapter) |
| `env.OBJECTS_VEC` (Vectorize) | `pgvector`-Spalte + `src/search/hybrid.ts` |
| `env.AI.run('@cf/baai/bge-m3')` | `ai.embed()` (Vertex text-embedding-005, 768-dim) |
| `env.IDEMPOTENCY_KV` | PG-Tabelle `idempotency_keys (key, response_body, expires_at)` |
| `env.MASTER_KEY` | `kek.wrap()` (OpenBao Transit, key `knowledge2`) |
| `wrangler.jsonc triggers.crons` | node-cron in-process (Phase 1), pg-boss (Phase 3) |
| FTS5-Virtual-Table | Postgres `tsvector`-Spalte + GIN-Index |

**Komplett neu:** `src/auth/jwks.ts` (JWKS-Pull statt Phase-1-Bearer-Fallback; Service-Token bleibt fuer `/v1/internal/*`).

---

## 4. Env-Var-Schema (zod, konsistent mit mcp-approval2)

Konvention: gleiche Naming-Schema-Namen wo das Konzept identisch ist. Compose-File-Aliases werden via `translateBootEnv()` (Pattern aus `apps/server/src/index.ts`) gemappt — der App-Code sieht IMMER den zod-Schema-Namen.

### 4.1 Schema (`apps/knowledge/src/lib/config.ts`)

```typescript
const ConfigSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  ORIGIN: z.string().url().default('http://localhost:8788'),

  // Database (Postgres primary, SQLite Tests/Dev)
  DATABASE_URL: z.string().min(1),
  DATABASE_DIALECT: z.enum(['postgres', 'sqlite']).default('postgres'),

  // Auth: JWKS-pull von mcp-approval2 + Service-Token fuer Internal-Routes
  JWKS_URL: z.string().url(),
  JWT_ISSUER: z.string().default('mcp-approval2'),
  JWT_AUDIENCE: z.string().default('mcp-knowledge2'),
  MCP_APPROVAL_INTERNAL_TOKEN: z.string().min(32),
  MCP_APPROVAL_BASE_URL: z.string().url(),

  // Blob (S3-API). bucket fix pro Deployment, endpoint+region+keys aus Doppler.
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),

  // KEK (OpenBao Transit)
  VAULT_ADDR: z.string().url(),
  VAULT_TOKEN: z.string().min(1),
  VAULT_TRANSIT_PATH: z.string().default('transit'),
  VAULT_TRANSIT_KEY: z.string().default('knowledge2'),

  // AI (Vertex EU)
  VERTEX_AI_PROJECT_ID: z.string().optional(),
  VERTEX_AI_REGION: z.string().default('europe-west4'),
  VERTEX_AI_EMBED_MODEL: z.string().default('text-embedding-005'),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(), // SA-JSON path

  // Backup (eigener Encryption-Key fuer Off-Site-Dumps)
  KNOWLEDGE_BACKUP_MASTER_KEY_BASE64: z.string().optional(),

  // Quality-Gate (ported from CF, optional)
  QUALITY_GATE_ENABLED: z.coerce.boolean().default(false),
  QUALITY_GATE_DAILY_USD: z.coerce.number().default(2.0),
  QUALITY_GATE_JUDGE_TIMEOUT_MS: z.coerce.number().default(30_000),
  QUALITY_GATE_JUDGE_MODEL: z.string().default('gemini-2.5-flash'),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});
```

### 4.2 Mapping Schema-Name ↔ Compose-Name ↔ Quelle

| SchemaName | ComposeName (env-block) | Quelle | Pflicht |
|---|---|---|---|
| `DATABASE_URL` | `DATABASE_URL` | `postgres://app:${POSTGRES_PASSWORD}@postgres:5432/knowledge2` | ✅ |
| `JWKS_URL` | `JWKS_URL` | hartkodiert `http://mcp-approval2:8787/.well-known/jwks.json` | ✅ |
| `JWT_ISSUER` | `JWT_ISSUER` | hartkodiert `mcp-approval2` | ✅ |
| `JWT_AUDIENCE` | `JWT_AUDIENCE` | hartkodiert `mcp-knowledge2` | ✅ |
| `MCP_APPROVAL_INTERNAL_TOKEN` | `MCP_APPROVAL_INTERNAL_TOKEN` | Doppler (shared mit mcp-approval2) | ✅ |
| `MCP_APPROVAL_BASE_URL` | `MCP_APPROVAL_BASE_URL` | hartkodiert `http://mcp-approval2:8787` | ✅ |
| `S3_ENDPOINT` | `S3_ENDPOINT` | Doppler (`https://fsn1.your-objectstorage.com`) | ✅ |
| `S3_REGION` | `S3_REGION` | Doppler (`fsn1`) | ✅ |
| `S3_BUCKET` | `S3_BUCKET` | Doppler (`mcp-knowledge2-eu`) | ✅ |
| `S3_ACCESS_KEY_ID` | `S3_ACCESS_KEY_ID` | Doppler (Hetzner-Object-Storage-User) | ✅ |
| `S3_SECRET_ACCESS_KEY` | `S3_SECRET_ACCESS_KEY` | Doppler | ✅ |
| `VAULT_ADDR` | `VAULT_ADDR` | hartkodiert `http://openbao:8200` | ✅ |
| `VAULT_TOKEN` | `VAULT_TOKEN` | Doppler (shared mit mcp-approval2 ODER eigener narrower scope) | ✅ |
| `VAULT_TRANSIT_KEY` | `VAULT_TRANSIT_KEY` | hartkodiert `knowledge2` | optional |
| `VERTEX_AI_PROJECT_ID` | `VERTEX_AI_PROJECT_ID` | Doppler (shared) | optional |
| `VERTEX_AI_REGION` | `VERTEX_AI_REGION` | Doppler (Default `europe-west4`) | optional |
| `GOOGLE_APPLICATION_CREDENTIALS` | `GOOGLE_APPLICATION_CREDENTIALS` | mount `/secrets/vertex-sa.json:ro` (shared mit mcp-approval2) | optional |
| `KNOWLEDGE_BACKUP_MASTER_KEY_BASE64` | `KNOWLEDGE_BACKUP_MASTER_KEY_BASE64` | Doppler (placeholder existiert schon) | optional |
| `PORT` | `PORT` | hartkodiert `8788` | optional |
| `LOG_LEVEL` | `LOG_LEVEL` | Doppler `LOG_LEVEL` (shared) | optional |

### 4.3 Konsistenz-Aenderungen gegen heutiges compose

Heutiges compose-File (Zeile 143ff.) erwartet alte Namen. Aenderungen: `VERTEX_REGION` → `VERTEX_AI_REGION`, `VERTEX_PROJECT_ID` → `VERTEX_AI_PROJECT_ID`, `BACKUP_MASTER_KEY` → `KNOWLEDGE_BACKUP_MASTER_KEY_BASE64`. Neu hinzufuegen: `S3_*` (5 Vars), `VAULT_*` (3 Vars), `MCP_APPROVAL_BASE_URL`. Alle drei Umbenennungen matchen bestehende Doppler-Placeholders.

---

## 5. Storage-Layer-Konkretisierung

### 5.1 Hetzner Object Storage als S3-Backend

**Endpoint-Form:** `https://{region}.your-objectstorage.com` (offiziell dokumentiert: docs.hetzner.com/storage/object-storage). Verfuegbare Regionen heute: `fsn1` (Falkenstein), `nbg1` (Nuernberg), `hel1` (Helsinki). Wir nehmen **`fsn1`** (gleiche Hetzner-Region wie der CX21).

**Bucket-Naming:**
- Pilot: `mcp-knowledge2-eu` (single-tenant Default).
- Spaeter (B-Pattern, 2. Firma): `mcp-knowledge2-{tenant-slug}-eu`. Multi-Tenant-Refactor ist explizit out-of-scope fuer Phase 1 (PLAN-architecture-v1 §0 Tenancy-Modell).

**Doppler-Vars (neu, im `doppler-setup`-Modul anzuhaengen):**
```
S3_ENDPOINT             = https://fsn1.your-objectstorage.com
S3_REGION               = fsn1
S3_BUCKET               = mcp-knowledge2-eu
S3_ACCESS_KEY_ID        = <Hetzner-Object-Storage-User-Access-Key>
S3_SECRET_ACCESS_KEY    = <Hetzner-Object-Storage-User-Secret>
S3_FORCE_PATH_STYLE     = true
```

**Kein Sharing der AWS_ACCESS_KEY_ID-Vars mit Terraform-State-Backend** — die TF-State-Vars (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `R2_ENDPOINT` im Doppler) zeigen heute auf einen Cloudflare-R2-Bucket fuer `terraform.tfstate`. Das bleibt. Knowledge2 bekommt **eigene** S3-Credentials (separate Hetzner-Object-Storage-User), Doppler-Naming `S3_*` macht das explizit.

### 5.2 Shared `S3BlobAdapter` ohne Aenderung

Der bestehende `S3BlobAdapter` in `/workspaces/mcp-approval2/packages/adapters/src/blob/s3.ts` unterstuetzt `endpoint`-Override + `forcePathStyle` und nutzt nur die S3-V2-API. Hetzner ist S3v4-API-konform (offiziell dokumentiert). Kein Adapter-Patch noetig.

### 5.3 Schluessel-Konvention

| Prefix | Owner | Zweck |
|---|---|---|
| `objects/<ULID>` | `apps/knowledge/src/objects/api.ts` | Body-Overflow `>16 KB` |
| `objects/<ULID>@v<n>` | `objects/api.ts` | Revision-Overflow |
| `backup/<ts>.bin` | `apps/knowledge/src/cron/backup.ts` | Wochen-Backup (encrypted mit `KNOWLEDGE_BACKUP_MASTER_KEY_BASE64`) |
| `uploads/<upload_id>` | `apps/knowledge/src/uploads/api.ts` | Pre-signed Upload-Buffer (12h-TTL via lifecycle-rule) |

`R2_KEY_REGEX`-Pattern aus `mcp-knowledge/src/objects/api.ts` (Audit-H12) wird 1:1 portiert als `S3_KEY_REGEX = /^(objects|uploads|backup)\//`. Defense-in-depth bleibt aktiv.

### 5.4 GCS-Migration (Phase 2)

Aenderungen bei Phase-2-Cutover:
1. **Auth:** Service-Account-Workload-Identity statt Access-Key/Secret. `S3BlobAdapter` kann GCS' S3-API benutzen, aber die saubere Loesung ist ein `GcsBlobAdapter` mit dem nativen `@google-cloud/storage`-SDK (Workload-Identity). Aufwand: 1 Tag, identisches Interface.
2. **Endpoint:** entfaellt (native SDK).
3. **Bucket-Namespace:** identisch (`mcp-knowledge2-eu` bleibt; GCS-Bucket-Namen sind global unique aber identische Strings sind ok wenn sie noch frei sind — ggf. `mcp-knowledge2-business-eu`).
4. **Env-Naming:** `GCS_BUCKET` + `GOOGLE_APPLICATION_CREDENTIALS` (letzteres bereits gesetzt fuer Vertex AI).

---

## 6. Vector/Embedding-Layer

### 6.1 pgvector statt Vectorize

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

**Dimension 1024 → 768** wegen Vertex `text-embedding-005`. Pilot leer (§9) → keine Migration. Wechsel zurueck waere `ALTER COLUMN ... TYPE vector(1024)` + Reindex.

**RRF-Fusion** im Detail in `apps/knowledge/src/search/hybrid.ts` — Pattern: parallele CTE `fts` (ts_rank) + `vec` (cosine via `<=>`-Operator), score = `1/(60+fts_rank) + 1/(60+vec_rank)`. Algorithmus 1:1 aus `mcp-knowledge/src/search/scorers.ts`.

### 6.2 Embedding-Source-Entscheidung: Vertex AI

**Wahl:** Vertex AI `text-embedding-005` via `AiAdapter.embed()`. Kein lokales `@xenova/transformers`.

**Trade-off-Tabelle:**

| Aspekt | Vertex AI | Lokales `@xenova/transformers` (bge-m3 ONNX) |
|---|---|---|
| Cost (Pilot ~1k embeds/Tag) | ~0.01 €/Tag (free Quota) | 0 € marginal |
| Latency p95 | 200-400 ms | 300-800 ms (CPU-only auf CX21) |
| Memory | 0 | +1-2 GB Heap (Modell + Tensor-Cache) → CX21 (8 GB) wird tight |
| Cold-Start | n/a | ~5s Modell-Load beim Container-Boot |
| Multilingual | ja (text-embedding-005) | ja (bge-m3 multilingual) |
| Dimension | 768 | 1024 |
| GCP-Phase-Konsistenz | identisch | divergiert (Anreiz, dort eh Vertex zu nehmen) |

**Begruendung Vertex:** mcp-approval2 nutzt eh Vertex (in Compose schon mounted: `vertex-sa.json:ro` Zeile 128 und 122 SET). Wir bekommen Adapter + Auth gratis, sparen CPU+RAM auf der kleinen Hetzner-VM, und Phase-2-GCP-Migration ist diff-frei. Bei kuenftigem Cost-Druck (>200k Embeddings/Tag) kann ein zweiter `LocalEmbeddingAdapter` jederzeit nachgeruestet werden — der Interface-Boundary `AiAdapter.embed()` ist da.

---

## 7. Auth-Pfad

### 7.1 RS256-JWT von mcp-approval2

- mcp-approval2 hostet JWKS unter `https://mcp2.ai-toolhub.org/.well-known/jwks.json` (Pattern aus `apps/server/src/auth/jwt-signing.ts` — Boot-Preflight existiert bereits).
- mcp-knowledge2 zieht JWKS via `jose.createRemoteJWKSet(new URL(JWKS_URL))` und cached intern (1:1 aus `mcp-knowledge/src/auth/jwt.ts`).
- Pro Request: `Authorization: Bearer <jwt>`, validation gegen JWKS, `sub` = `userId` (UUID, NICHT email — vgl. PLAN-architecture-v1 §2.1).
- Compose-File-Mode: in der Hetzner-VM ist `JWKS_URL=http://mcp-approval2:8787/.well-known/jwks.json` (internal-network). Beide Container laufen im selben Docker-Network. Production-Frontend (`mcp2.ai-toolhub.org`) wird im Compose nicht durchgereicht — Caddy ist davor.

### 7.2 Bearer-Service-Token fuer Internal-Routes

`/v1/internal/erase-user` (D-10 aus Cross-Service-Contract) braucht den statischen `MCP_APPROVAL_INTERNAL_TOKEN` als Bearer, NICHT user-JWT. Begruendung steht in `packages/adapters/src/knowledge/interface.ts:117ff.` — GDPR-Cascade ist Admin-Route, kein User-Subject.

Implementation in `apps/knowledge/src/auth/bearer.ts`:
```typescript
export function checkServiceBearer(req: Request, env: Env): boolean {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  return timingSafeEqual(token, env.MCP_APPROVAL_INTERNAL_TOKEN);
}
```

Smoke-Tests + CI-Health-Checks gegen `/health` brauchen keinen Token (200 ohne Auth).

### 7.3 Kein Cookie-Pfad

mcp-knowledge2 ist headless. Kein Browser-Surface, keine PWA, kein OAuth-Redirect — alle Aufrufe kommen von mcp-approval2 (User-JWT) oder von einem GH-Action-Smoke (Service-Token). Kein Set-Cookie, keine CSRF-Schicht.

---

## 8. Tool-Surface (Mapping CF Worker → v2)

### 8.1 Bestand heute (`/workspaces/mcp-knowledge/src/tools/`)

| Familie | # Tools | v2-Behandlung |
|---|---|---|
| `core.ts` | 12 | direkt mappable auf REST + MCP-Adapter |
| `docs/*` | 8 | trivial Port |
| `skills/*` | 15 | trivial Port |
| `memorize/*` | 6 | trivial Port; embed_helper auf AiAdapter |
| `apps/*` | 17 | trivial Port (state via objects-API) |
| `objects/*` | 1 (`bulk_delete`) | trivial |
| `search.ts` | 1 | rewrite auf pgvector RRF |
| `quality/*` | 4 | AiAdapter ersetzt AI-Gateway-Slug |

Insgesamt ~64 Tools — Surface bleibt 1:1, **kein Tool-Cut** in v2.

### 8.2 Was Anpassung wegen Adapter-Wechsel braucht

| Tool | Aenderung |
|---|---|
| `objects.put` (alle Varianten) | `body` ist heute `Uint8Array | string`; im v2-Wire ist `body_b64` (base64) — bereits aligned via http-client (D-2 done in mcp-approval2). |
| `docs.put` mit Vectorize-Embed | `embed: true` triggert heute `env.AI.run(@cf/baai/bge-m3)`. v2: `aiAdapter.embed({texts: [maskedSummary]})`. Dimension Schema-Change 1024→768. |
| `memorize.add` | gleich (server-side embed-Pfad) |
| `search` | Komplett rewrite auf RRF-Pattern aus §6.1. Tool-Schema bleibt identisch. |
| `quality.run_backfill` | AI-Gateway-Slug-URL entfaellt; direkter Vertex-Call via AiAdapter. AI-Gateway-Cost-Tracking wandert ggf. spaeter in `audit_log`-Sink. |
| `uploads.init` + PUT-flow | heute HMAC-signed-URL gegen R2-public-presigned-PUT. v2: same Pattern aber `s3.createPresignedPost()` (AWS-SDK) — kein Custom-HMAC mehr noetig. |

### 8.3 MCP-Adapter (tools/list, tools/call): Reuse

`src/routes/mcp.ts` aus dem CF-Worker laeuft trivial in Node (kein CF-spezifischer-API-Call). 1:1 portieren in `apps/knowledge/src/routes/mcp.ts`. `tools/registry` (`/workspaces/mcp-knowledge/src/tools/registry.ts`) ist plain-TS, Side-Effect-imports kosten nichts. Initialize + protocolVersion + JSON-RPC error codes bleiben.

---

## 9. Migration-Path

### 9.1 Daten in CF-Production bleiben unberuehrt

`/workspaces/mcp-knowledge` (Production `knowledge.ai-toolhub.org`) ist heute aktiv im mcp-approval-Stack auf Cloudflare. Bei mcp-approval2-Cutover wird die alte mcp-approval-Instanz sunset; sobald das passiert, hat `knowledge.ai-toolhub.org` keine schreibenden Clients mehr. Die Daten bleiben in R2/D1 als 1-Monats-Archiv und werden danach gepurgt (Sunset-Schedule outside-of-scope dieses Plans).

### 9.2 mcp-approval2 ↔ mcp-knowledge2 API-Surface (heute schon definiert)

Aus `packages/adapters/src/knowledge/`:

| API-Call | mcp-approval2-Surface | mcp-knowledge2-Endpoint |
|---|---|---|
| `createObject` | `services/knowledge.ts` | `POST /v1/objects` |
| `getObject` | `services/knowledge.ts` | `GET /v1/objects/:id?expand=body` |
| `listObjects` | `services/knowledge.ts` | `GET /v1/objects?kind=&subtype=&limit=&cursor=` |
| `updateObject` | `services/knowledge.ts` | `PATCH /v1/objects/:id` |
| `deleteObject` | `services/knowledge.ts` | `DELETE /v1/objects/:id` |
| `createShare` | `services/knowledge.ts` | `POST /v1/objects/:id/shares` |
| `listShares` | `services/knowledge.ts` | `GET /v1/objects/:id/shares` |
| `revokeShare` | `services/knowledge.ts` | `DELETE /v1/shares/:id` |
| `search` | `services/knowledge.ts` | `POST /v1/search` |
| `eraseUser` (Internal) | `services/gdpr.ts` | `POST /v1/internal/erase-user` (Service-Token) |

v2 MUSS diese 10 Endpoints (plus MCP-Adapter + Health) liefern. Aktueller HttpKnowledgeAdapter sendet snake_case body-Felder + erwartet camelCase response — server-side handler in v2 muessen das spiegeln (D-1..D-12 alle resolved in mcp-approval2/docs/CROSS-SERVICE-CONTRACT-RESOLUTION.md — der Vertrag ist die Baseline).

### 9.3 v2 startet leer

Pilot auf Hetzner ist ein Greenfield: leere `objects`-Tabelle, leerer S3-Bucket, leerer pgvector-Index. Kein Daten-Import von CF Workers noetig — alle relevanten Daten gehoeren dem User axelroggnotfall@gmail.com und werden bei Bedarf manuell re-created (Skills/Docs sind klein, Apps sind State, Memos sind regenerierbar). Falls doch Bedarf entsteht: ein-shot `dump-from-cf.ts`-Skript wird in Phase-X gebaut, bleibt aber out-of-scope dieses Plans.

---

## 10. Build + Deploy

### 10.1 Dockerfile (`apps/knowledge/Dockerfile`)

Pattern 1:1 wie `/workspaces/mcp-approval2/deploy/fly/Dockerfile.server`:
- `deps` Stage: workspace-aware `npm ci`, includes `apps/knowledge/package.json` neben den existierenden 4 manifests.
- `build` Stage: `npm run build -w @mcp-approval2/core && ... -w @mcp-approval2/adapters && ... -w @mcp-approval2/knowledge`.
- `prod-deps`: re-install `--omit=dev`.
- `runtime` Stage: copy `apps/knowledge/dist`, `apps/knowledge/migrations`, `apps/knowledge/scripts`, `apps/knowledge/package.json`. WORKDIR `/app/apps/knowledge`. CMD `node --enable-source-maps dist/index.js`.
- HEALTHCHECK `wget -q --spider http://localhost:8788/health || exit 1`.

Image-Tag wahlweise:
- `ghcr.io/axel-rogg/mcp-knowledge2:latest` (behalten — compose referenziert das schon)
- ODER `ghcr.io/axel-rogg/mcp-approval2-knowledge:latest` (semantisch sauberer)

Entscheidung User-Frage (siehe §11) — Default-Vorschlag: behalten, weil compose-Refactor zusaetzlicher Diff ist und der Tag-Name nicht load-bearing.

### 10.2 Migrations

`apps/knowledge/scripts/migrate.ts` 1:1 nach Pattern `apps/server/scripts/migrate.ts`. Drizzle-folder ist `apps/knowledge/migrations/`. Aufruf: `npx tsx scripts/migrate.ts` im Container, vor dem Hono-Start. Compose-File-Trick: wir machen das via `setup.sh`-on-first-boot ODER via `dockerize -wait` mit conditional `init`-step. Vorschlag: ein dediziertes `mcp-knowledge2-migrate` compose-service mit `restart: "no"` der das einmal laufen laesst und exited.

### 10.3 Compose-Service-Wiring

Aenderungen an `deploy/hetzner/docker-compose.yml` Zeile 143-173 — neuer environment-Block mit den §4.2 zod-Schema-Namen, alle Pflicht-Vars + Defaults wo sinnvoll. `volumes` mount `vertex-sa.json:ro` (shared). `depends_on`: postgres (healthy) + openbao (started) + mcp-approval2 (started). HEALTHCHECK `wget http://localhost:8788/health`. Watchtower-Label setzen. `postgres-init.sql` erweitern um `CREATE DATABASE knowledge2;` + `CREATE EXTENSION vector;` in beiden DBs.

### 10.4 Doppler-Placeholder-Liste

Anzuhaengen in `terraform/modules/doppler-setup/main.tf` (alle mit `ignore_changes = [value]`):

```
S3_ENDPOINT             (Default: https://fsn1.your-objectstorage.com)
S3_REGION               (Default: fsn1)
S3_BUCKET               (Default: mcp-knowledge2-eu)
S3_ACCESS_KEY_ID        (User traegt manuell ein)
S3_SECRET_ACCESS_KEY    (User traegt manuell ein)
S3_FORCE_PATH_STYLE     (Default: true)
KNOWLEDGE_TAG           (Default: latest)
```

`KNOWLEDGE_BACKUP_MASTER_KEY_BASE64`, `VAULT_TOKEN`, `VERTEX_AI_*`, `MCP_APPROVAL_INTERNAL_TOKEN`, `POSTGRES_PASSWORD` sind alle schon vorhanden.

### 10.5 Caddyfile

Add new vhost in `deploy/hetzner/Caddyfile.tpl`:
```
{$DOMAIN_KNOWLEDGE} {
  reverse_proxy mcp-knowledge2:8788
}
```

Doppler-Var `DOMAIN_KNOWLEDGE` (Default `knowledge2.ai-toolhub.org`) existiert bereits. Cloudflare-DNS-Record terraformed in `terraform/modules/cloudflare-dns/`.

---

## 11. Risiken + Offene Fragen

### 11.1 Risiken

| Risiko | Wahrscheinlichkeit | Mitigation |
|---|---|---|
| pgvector hnsw-Index ist viel groesser als geplant (Pilot 100 GB+ blow-up bei vielen embeds) | niedrig (Pilot Single-User, ~1k objects realistisch) | Index-Tuning `m=8, ef_construction=32`; falls weiter problematisch: IVFFlat statt HNSW |
| Vertex `text-embedding-005` Daily-Quota fuer Free-Tier hit (Pilot mehrere User) | mittel | Quota-Hook in `aiAdapter.embed()`, retry-with-backoff; fallback auf cached embed bei Quota-Exhaust |
| OpenBao Transit-Engine Boot-Race mit mcp-knowledge2 (Compose `depends_on: service_started` reicht nicht, openbao braucht erst manuelle init) | hoch | Boot-Preflight `waitForVault()` analog `waitForDb()` aus `apps/server/src/index.ts`, mit 60s-Budget |
| JWKS-Pull schlaegt fehl wenn mcp-approval2 noch nicht ready ist | mittel | `jose.createRemoteJWKSet` cached + retried automatisch; falls 503 beim ersten Request: client-side retry mit 5s-delay |
| Hetzner Object Storage Latenz schlechter als R2 (multi-region-Edge fehlt) | mittel | wir sind eh single-region (fsn1) + Hetzner-VM ist auch in fsn1. p95 sollte <50ms sein. Falls problematisch: CDN-Layer via Cloudflare vor S3-Bucket (lesen-only). |
| `idempotency_keys`-PG-Tabelle wird hot (jede mutation schreibt) | niedrig | Index auf `(key)` + scheduled cleanup-job (`pg-boss` hourly delete-where-expired). Heutiges CF-KV ist ohnehin nicht atomic mit der eigentlichen Mutation — PG ist semantisch sauberer. |
| Cross-Service-Contract-Drift bei Schema-Aenderungen in mcp-knowledge2 | mittel | Vitest-Suite `apps/knowledge/tests/contract.test.ts` snapshots der OpenAPI-Shape. CI bricht bei unintended-diff. |
| Migration der CF Worker-AI 1024-dim Vectors waere Datenverlust (kein Re-embed-Tool) | niedrig (Pilot leer) | nicht migrieren; v2 startet leer. Falls doch noetig: einmaliger `re-embed.ts`-Skript der alle objects neu durch Vertex jagt. |
| Adapter-Coupling (Verlockung `import` quer-rein im Monorepo) | hoch | ESLint `no-restricted-paths`: `apps/server/**` darf nicht aus `apps/knowledge/**` importieren und vice versa. Kommunikation MUSS HTTP-Adapter. |

### 11.2 Offene Fragen — User-Entscheidung erforderlich

**Q1: Image-Tag-Naming.** Behalten wir `ghcr.io/axel-rogg/mcp-knowledge2` (heute schon im compose) oder umbenennen auf `ghcr.io/axel-rogg/mcp-approval2-knowledge` (semantisch sauberer im Monorepo-Kontext)?
**Default-Vorschlag:** behalten.

**Q2: Crypto-Reuse mit `@mcp-approval2/core`?** Der CF-Worker hat eigene Crypto-Module in `src/crypto/`. mcp-approval2/core hat ebenfalls Crypto-Primitives. Wir koennen die der mcp-approval2/core 1:1 reusen ODER bewusst fork-en damit die Service-Boundary auch Crypto-Boundary ist.
**Default-Vorschlag:** Reuse von `@mcp-approval2/core/crypto`. Die AAD-Convention ist semantisch identisch (`<recordType>|<id>|<kind>:<subtype>`).

**Q3: Embedding-Dimension 768 oder 1024?** Vertex `text-embedding-005` ist 768. Optionale Vertex `text-multilingual-embedding-002` ist auch 768. Wenn wir spaeter bge-m3 ueber `@xenova/transformers` als zweiten Adapter wollen (1024-dim) waere `vector(1536)`-Spalte oversize-Investment.
**Default-Vorschlag:** `vector(768)`. Wechsel ist Schema-Migration ohne Data-Loss-Risiko (Pilot leer).

**Q4: Idempotency-Layer in PG oder Redis?** PG ist einfach (kein neuer Container). Redis ist schneller (TTL native). Single-User-Pilot — PG reicht.
**Default-Vorschlag:** PG.

**Q5: Cron-Engine?** `node-cron` im selben Hono-Prozess (einfach, kein Service-Container) ODER `pg-boss` (separater Worker-Container, robust gegen App-Restarts).
**Default-Vorschlag:** Phase 1 `node-cron` in-process, Phase 3 Migration auf `pg-boss` wenn Job-Vielfalt waechst.

**Q6: Uploads-Pre-Signed-Layer.** Hetzner Object Storage unterstuetzt presigned-PUT (S3v4). Kein Custom-HMAC-Layer mehr noetig wie im CF-Worker. Default-Vorschlag: Drop des HMAC-Pfads, Vorab-Sign mit `@aws-sdk/s3-request-presigner`.

**Q7: Sharing-Layer.** Aktueller CF-Worker hat KEINE Shares-Tabelle (single-user). v2 muss Shares fuer Multi-User-Story bauen — Decision dazu in mcp-approval2 PLAN-architecture-v1 §2.1 schon getroffen. Schema folgt aus dem Knowledge-Adapter-Interface (CreateShareArgs etc.).
**Status:** keine offene Frage, schon entschieden. Erwaehnt fuer Tracking.

**Q8: TF-State-Backend.** Bleibt R2 (Doppler `R2_ENDPOINT`)? Oder Migration auf Hetzner Object Storage (gleicher Bucket-Provider wie App)?
**Default-Vorschlag:** TF-State bei R2 belassen — CLAUDE.md §"Infrastructure-Policy" sagt explizit "TF-State darf bei R2 bleiben". Keine Aenderung.

---

## 12. Implementation-Sequenz

**Schaetzung Vollzeit-Stunden:** Single-Engineer (Axel), 6-7 Wochen Wall-Time bei 30h/Woche fokussiert + Cross-Repo-Sync gegen mcp-approval2.

### Phase 0 — Setup (4-6 h)
- `apps/knowledge/`-Skeleton im Monorepo: package.json, tsconfig.json (extends `tsconfig.base.json`), vitest.config.ts, biome.json-include
- `npm install -w @mcp-approval2/knowledge` ergaenzt Workspace
- ESLint `no-restricted-paths` zwischen `apps/server/**` und `apps/knowledge/**`
- Smoke `npm run typecheck` muss durchlaufen mit leerem `src/index.ts`-Stub

### Phase 1 — DB + Migrations + Adapter-Wiring (10-14 h)
- Drizzle-Schema fuer objects + object_refs + object_tags + object_revisions + uploads + idempotency_keys + audit_log
- `migrations/0001_objects.sql` (Postgres-Variant inkl. pgvector + tsvector)
- `scripts/migrate.ts` + `scripts/health-check.ts` 1:1 wie apps/server
- `src/lib/config.ts` (zod) + `src/lib/db.ts` (createDbAdapter)
- `src/app-factory.ts` mit `createApp({config, db, blob, kek, ai})`-Signature
- `src/index.ts` mit `translateBootEnv()` + `waitForDb()` + `waitForVault()` Pattern
- Compose-Postgres-Init erweitern auf `CREATE DATABASE knowledge2;` + `CREATE EXTENSION vector;`

### Phase 2 — Auth + Health (4-6 h)
- `src/auth/jwks.ts` + `src/auth/jwt.ts` (port aus mcp-knowledge/src/auth/jwt.ts + jose.createRemoteJWKSet)
- `src/auth/bearer.ts` (service-token check, timingSafeEqual)
- `src/routes/health.ts` (GET /health, /version, /.well-known/health)
- Vitest fuer JWT-Validation gegen Stub-JWKS

### Phase 3 — Objects-API + REST-Routes (16-20 h)
- Port `src/objects/api.ts` (CRUD + refs + tags + revisions) — D1→Drizzle, R2→BlobAdapter, eingebauter `KekProvider.wrap`/`unwrap`-Aufruf bei Encrypt/Decrypt
- Port `src/uploads/api.ts` — Hetzner-S3-presigned-PUT statt CF-HMAC
- REST-Handler `src/routes/objects.ts`, `src/routes/shares.ts`, `src/routes/uploads.ts`, `src/routes/internal.ts`
- Idempotency-Middleware (PG-backed) — port aus `src/middleware/idempotency.ts`
- Vitest-Suite: createObject, getObject(expand=body), updateObject (CAS), deleteObject, refs, tags, share-CRUD, eraseUser (Service-Token)
- Contract-Test gegen das `HttpKnowledgeAdapter` aus `packages/adapters` (in-process spinup von beiden)

### Phase 4 — Search + Embeddings (8-12 h)
- `src/embed/vertex.ts` — wrapper um `aiAdapter.embed()` mit PII-mask + 8k-char-Limit
- `src/search/hybrid.ts` — RRF-Fusion-Query
- `src/routes/search.ts`
- Vitest: hybrid-search relevance-smoke (kleines Sample mit ground-truth)

### Phase 5 — MCP-Adapter + Tool-Surface (16-20 h)
- Port `src/mcp/registry.ts` + `src/routes/mcp.ts` + Side-Effect-Imports
- Pro Tool-Familie ein Subagent-Slice: `mcp/tools/{docs,skills,memorize,apps,objects,search,quality}` (60+ Tools total)
- `apps/blocks/*` (22 blocks) trivial port — reine Schema-Definitions
- Vitest: tools/list (count + shape), tools/call smoke (1 per Familie)

### Phase 6 — Quality-Gate + Apps-State + Pilot-Smoke (6-10 h)
- Quality-Gate-Hook: `apps/knowledge/src/quality/{judge,rubric}.ts`
- Apps-State-Layer (`apps/api.ts`, types_registry, legacy_to_layout)
- Composable-Apps-Tests aus dem CF-Repo portieren
- Pilot-Smoke-Skript `scripts/pilot-smoke-knowledge.sh` (Pattern aus `scripts/pilot-smoke.sh`)
- Cron in-process (node-cron) fuer uploads-sweep + uploads-purge + weekly-backup

### Phase 7 — Deploy + Hetzner-Cutover (8-12 h)
- Dockerfile `apps/knowledge/Dockerfile` + GHCR-build-action
- Compose-Update + Caddyfile-vhost
- Doppler-Placeholders (S3_*-Vars)
- Terraform: Hetzner-Object-Storage-Bucket + Cloudflare-DNS fuer `knowledge2.ai-toolhub.org`
- Initial-Deploy: VM SSH, `docker compose pull && up -d`, migrate-job once, smoke
- Watchtower automatisch picked up das ghcr.io-Image (label `com.centurylinklabs.watchtower.enable: "true"` schon im compose)

**Phase 0-6: ~64-88 h Dev. Phase 7: 8-12 h.** Realistisch 5-6 Wochen bei 30h/Woche fokussiert. Bei parallelen Subagent-Slices in Phase 3+5 deutlich schneller.

---

**Ende des Plans. Begleitend zu pflegen:** `docs/CROSS-SERVICE-CONTRACT.md` (existiert in mcp-approval2 partiell) — bei Schema-Aenderungen im v2 simultaner Sync mit dem `KnowledgeAdapter`-Interface in `packages/adapters/src/knowledge/types.ts`.
