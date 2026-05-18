# PLAN: Tool-Defaults v2 — vollständige Umsetzung

> **Status:** ⚠️ Entwurf 2026-05-18 (Implementation-Ready) — Phase A in Umsetzung
>
> **Entscheidungen 2026-05-18 (User):**
> 1. `__profile`-Schutz: Lint + Runtime-Reject (fail-CLOSED) + Reservierungs-Liste für Sub-MCP-Server-Names (`apps`, `docs`, `skills`, `kc`, `tools`, `prefs`, `tool_defaults`, `groups`, `native`, `memorize`).
> 2. Elicit-Default-State: OFF. Toggle in Settings + Onboarding-Toast beim ersten Hint.
> 3. Sub-MCP-Name-Extraktion: Heuristik mit `subMcpServerNames`-Set + Reservierungs-Liste; kein per-Tool `meta.namespace`.
> 4. Secret-Refs: out-of-scope. Soft-Block-Heuristik im `tool_defaults.set`-Handler bei Feldnamen-Suffix `_key`/`_token`/`_secret`/`_password`.
> 5. Drift-Detection: Soft-Mark via `orphan_since BIGINT NULL` auf `user_server_tool_defaults`. Lazy-Write im Resolver, rote Markierung im PWA-Defaults-Tab.
>
> **Trigger (User 2026-05-18):**
> 1. UX: Parameter **auswählen** statt frei tippen (Schema-aware Dropdown).
> 2. Typ muss passen — kein Free-Text in `number`/`boolean`/`enum`.
> 3. Wie wird das Setzen initiiert? Inkl. `tools/help`-Pfad fürs LLM.
> 4. **Mehrfachkonfigurationen** (z.B. zwei DB-Profile: `prod`/`test`).
> 5. **Strikte Per-User-Isolation**: jeder User hat seine eigene Profile-Menge, sein eigenes aktives Profil, seine eigenen Defaults. Kein User sieht/ändert die eines anderen. Kein Operator-Shared-Default-Set.
>
> **Vorbedingung:** PLAN-tools-tab-ux-refactor Phase A–F live; Mig 0024 vorhanden; PWA-Tab `#/tools/servers/<name>/defaults` existiert.
> **Ziel-Branch:** `feat/tool-defaults-v2` (von `main` abgezweigt), Phasen-Commits dort, Merge-back nach Phase F-Smoke.

---

## 1. Ist-Zustand (Verdichtet)

Drei Default-Schichten liegen nebeneinander, keine ist aktiv im Dispatch-Pfad:

| Schicht | Storage | Status |
|---|---|---|
| **A** `user_tool_prefs` (Mig 0009), MCP-Tools `prefs.*` + `PrefsService.resolveForTool` | flat jsonb-Rows, scope-aware | Service vorhanden, **kein Caller** in `transport.ts`. REST `/v1/prefs` nicht montiert. |
| **B** `user_server_tool_defaults` (Mig 0024), REST `/v1/me/servers/:srv/tool-defaults`, PWA-Tab | per-Server, `value_text TEXT`, ein Wert pro `(srv, tool, field)` | UI schreibt; **kein Hook beim Tool-Call** liest. |
| **C** `user_prefs` (Mig 0008), encrypted envelope | totes Schema, kein Service | — |

Tool-Call in [transport.ts:494-505](apps/server/src/mcp/protocol/transport.ts#L494-L505) reicht `params.arguments` 1:1 in `registry.dispatch({input: …})`. Approval-Row in [schema/postgres/approvals.ts:102](apps/server/src/schema/postgres/approvals.ts#L102) hat keine `defaults_applied`-Spalte. Tool-Naming-Konventionen für Default-Routing: `kc.<…>` (KC-Wrappers), `<srv>.<tool>` (Sub-MCP-Wrappers wo `<srv>` in `subMcpServerNames`), bare (`docs.put`, `apps.invoke`) für native.

---

## 2. Konzept-Kern (Anforderungs-Mapping)

| User-Frage | Konzept |
|---|---|
| ① UX Parameter-Picker | PWA liest `inputSchema` aus `tools/list._meta.inputSchema`, rendert Dropdown der Properties + pro Property das passende Widget. |
| ② Typ muss passen | `value_text TEXT` → `value_json jsonb`. App-side Zod-Validation gegen Tool-`inputSchema` vor `set`. |
| ③ Initiation | (a) PWA proaktiv; (b) neues natives `tools.help` Read-Tool + `_meta.defaults_summary` in jeder `tools/list`-Antwort; (c) MCP-Elicitation auf DANGER ohne Default (Capability-checked, default OFF). |
| ④ Multi-Konfiguration | `user_tool_default_profiles(user_id, sub_mcp_name, profile_name, is_active)`. Per-Call-Override via reserviertes Arg `__profile`. Default-Profil heißt `default`. |
| ⑤ Per-User-Isolation | Alle neuen Tabellen `user_id`-PK + RLS-Policy `current_setting('app.current_user')`. Keine `tenant`/`shared`-Konzepte. Profile-Namen kollidieren pro User unabhängig. |

---

## 3. Schema (Migration 0027)

`apps/server/migrations/0027_tool_defaults_v2.sql`:

```sql
-- 0027_tool_defaults_v2.sql — Profile + typed Values + Hints.
--
-- Plan-Ref: docs/plans/active/PLAN-tool-defaults-v2.md (Phase B+C+E).
--
-- Per-User isoliert via RLS. Keine tenant/shared-Konzepte.

BEGIN;

-- ── 1. Profile-Tabelle (pro user × sub_mcp_name) ───────────────────────────
CREATE TABLE user_tool_default_profiles (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub_mcp_name TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  is_active    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (user_id, sub_mcp_name, profile_name),
  CHECK (profile_name ~ '^[a-z][a-z0-9_-]{0,63}$')
);

-- Genau ein aktives Profil pro (user, sub_mcp_name) — partial unique index.
CREATE UNIQUE INDEX idx_utdp_one_active
  ON user_tool_default_profiles(user_id, sub_mcp_name)
  WHERE is_active = TRUE;

CREATE INDEX idx_utdp_user_server
  ON user_tool_default_profiles(user_id, sub_mcp_name);

ALTER TABLE user_tool_default_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY utdp_owner_only ON user_tool_default_profiles
  USING (user_id = current_setting('app.current_user', true)::UUID)
  WITH CHECK (user_id = current_setting('app.current_user', true)::UUID);

-- Seed: jeder existierende User × jeder Server → 'default'-Profil mit
-- is_active=TRUE. So sind alle bestehenden Mig-0024-Rows zuordbar.
INSERT INTO user_tool_default_profiles
  (user_id, sub_mcp_name, profile_name, description, is_active, created_at, updated_at)
SELECT DISTINCT
  user_id,
  sub_mcp_name,
  'default',
  'Auto-created on 0027 migration',
  TRUE,
  EXTRACT(EPOCH FROM now()) * 1000,
  EXTRACT(EPOCH FROM now()) * 1000
FROM user_server_tool_defaults
ON CONFLICT DO NOTHING;

-- ── 2. user_server_tool_defaults: + profile_name + value_json ──────────────
-- profile_name NOT NULL DEFAULT 'default' damit alle Bestands-Rows zuordbar
-- sind. PK-Change in einem Statement.
ALTER TABLE user_server_tool_defaults
  ADD COLUMN profile_name TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN value_json   JSONB,
  ADD COLUMN value_kind   TEXT NOT NULL DEFAULT 'text',
  ADD COLUMN orphan_since BIGINT NULL;
-- value_kind ∈ {'text','json','number','boolean','enum'} — App-side validation.
-- orphan_since wird vom Resolver lazy gesetzt, wenn field im tool.inputSchema fehlt.

-- Lazy-Migrate: kopiere value_text in value_json bei 'text'-kind. Wird beim
-- ersten Read durch Service::asTypedValue() lazy-resolved (siehe §5.2).
-- Hier nur Schema. Migrations-Script in scripts/migrate-tool-defaults.ts
-- ist optional (idempotent).

ALTER TABLE user_server_tool_defaults
  DROP CONSTRAINT user_server_tool_defaults_pkey;
ALTER TABLE user_server_tool_defaults
  ADD CONSTRAINT user_server_tool_defaults_pkey
  PRIMARY KEY (user_id, sub_mcp_name, profile_name, tool_name, field_name);

CREATE INDEX idx_usttd_user_server_profile
  ON user_server_tool_defaults(user_id, sub_mcp_name, profile_name);

-- ── 3. Hints (global pro Tool, profile-übergreifend) ───────────────────────
CREATE TABLE user_tool_default_hints (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub_mcp_name TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  field_name   TEXT NOT NULL,
  hint_text    TEXT NOT NULL,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (user_id, sub_mcp_name, tool_name, field_name),
  CHECK (length(hint_text) <= 500)
);

CREATE INDEX idx_utdh_user_tool
  ON user_tool_default_hints(user_id, sub_mcp_name, tool_name);

ALTER TABLE user_tool_default_hints ENABLE ROW LEVEL SECURITY;

CREATE POLICY utdh_owner_only ON user_tool_default_hints
  USING (user_id = current_setting('app.current_user', true)::UUID)
  WITH CHECK (user_id = current_setting('app.current_user', true)::UUID);

-- ── 4. Per-Tool Active-Profile-Override (Stretch) ──────────────────────────
CREATE TABLE user_tool_active_profile (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub_mcp_name TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (user_id, sub_mcp_name, tool_name)
);

ALTER TABLE user_tool_active_profile ENABLE ROW LEVEL SECURITY;

CREATE POLICY utap_owner_only ON user_tool_active_profile
  USING (user_id = current_setting('app.current_user', true)::UUID)
  WITH CHECK (user_id = current_setting('app.current_user', true)::UUID);

-- ── 5. Approval-Row: defaults_applied-Snapshot ─────────────────────────────
-- WYSIWYS: bei Approval-Issue persistieren wir, welche Felder vom
-- Default-System kamen, mit Source. Bei Resume kein Re-Resolve, sondern
-- direkt aus toolInput dispatchen.
ALTER TABLE pending_approvals
  ADD COLUMN defaults_applied JSONB NOT NULL DEFAULT '[]'::jsonb;
-- Shape: [{ field: string, from: 'tool-default'|'user-input', scope?, profile?: string }]

-- ── 6. Cascade-Cleanup bei sub_mcp_servers DELETE ──────────────────────────
-- Existierender Trigger (Mig 0024) räumt user_server_tool_defaults.
-- Wir hängen unsere neuen Tabellen mit dran.
CREATE OR REPLACE FUNCTION utd_cascade_on_submcp_delete()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM user_server_tool_defaults     WHERE sub_mcp_name = OLD.name;
  DELETE FROM user_tool_default_profiles    WHERE sub_mcp_name = OLD.name;
  DELETE FROM user_tool_default_hints       WHERE sub_mcp_name = OLD.name;
  DELETE FROM user_tool_active_profile      WHERE sub_mcp_name = OLD.name;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_usttd_cascade_submcp_delete ON sub_mcp_servers;
CREATE TRIGGER trg_utd_cascade_submcp_delete
  AFTER DELETE ON sub_mcp_servers
  FOR EACH ROW EXECUTE FUNCTION utd_cascade_on_submcp_delete();

COMMIT;
```

**Drizzle-Schema** (`apps/server/src/schema/postgres/tool-defaults-v2.ts`, neu):

```ts
import {
  bigint, boolean, index, jsonb, pgTable, primaryKey, text, uuid,
} from 'drizzle-orm/pg-core';

export const userToolDefaultProfilesTable = pgTable('user_tool_default_profiles', {
  userId:       uuid('user_id').notNull(),
  subMcpName:   text('sub_mcp_name').notNull(),
  profileName:  text('profile_name').notNull(),
  description:  text('description').notNull().default(''),
  isActive:     boolean('is_active').notNull().default(false),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => ({
  pk:    primaryKey({ columns: [t.userId, t.subMcpName, t.profileName] }),
  byUsr: index('idx_utdp_user_server').on(t.userId, t.subMcpName),
}));

export const userToolDefaultHintsTable = pgTable('user_tool_default_hints', { /* analog */ });
export const userToolActiveProfileTable  = pgTable('user_tool_active_profile',  { /* analog */ });
// userServerToolDefaultsTable (existiert) wird in derselben Datei erweitert.
```

Append in [schema/postgres/index.ts](apps/server/src/schema/postgres/index.ts).

---

## 4. Datenfluss (End-to-End)

```
┌─ PWA ──────────────────────────────────────────────────────────────┐
│ #/tools/servers/<srv>/defaults                                     │
│   Profile-Switcher [prod|test|+]                                   │
│   Field-Picker aus inputSchema (typed widget pro property)         │
│   → PUT /v1/me/servers/:srv/tool-defaults/:tool/:field             │
│     body: {value: <typed>, profile: "prod", valueKind: "number"}   │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─ ToolDefaultsService (neu) ────────────────────────────────────────┐
│ validate(value, tool.inputSchema, field) → store in jsonb          │
│ resolveForTool(userId, toolName, args, profileOverride?)           │
│   1. lookup sub_mcp_name from tool-name prefix                     │
│   2. resolve profile: argOverride > perToolActive > serverActive   │
│   3. merge: args wins, defaults fill gaps                          │
│   4. attribute each field with source                              │
│   → { resolvedInput, defaultsApplied[] }                           │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─ transport.ts:handleToolsCall (modified) ──────────────────────────┐
│ const {resolvedInput, defaultsApplied} =                           │
│   toolDefaults?.resolveForTool(...)                                │
│ registry.dispatch({input: resolvedInput, defaultsApplied, ...})    │
└────────────────────────────────────────────────────────────────────┘
                              │
            ┌─────────────────┴────────────────┐
            ▼                                  ▼
┌─ Read-Tool: execute ────┐    ┌─ Write/Danger: enqueueApproval ────┐
│ direkt dispatchen       │    │ persist toolInput + defaultsApplied │
└─────────────────────────┘    │ display_rendered enthält Badges    │
                               │ PWA approve → Resume mit gleichem  │
                               │ toolInput (kein Re-Resolve)        │
                               └─────────────────────────────────────┘
```

---

## 5. Implementation pro Phase

### Phase A — Resolver-Wire-In (~4h, kein Schema-Change)

**Ziel:** Bestehende Mig-0024-Defaults werden endlich gemerged. Approval-PWA zeigt Attribution. Kein typed-Value, kein Profile, kein Hints — minimaler Schritt um sichtbaren Wert zu schaffen.

**Files (Edit):**

1. **`apps/server/src/services/tool-defaults.ts` (NEU)** — extrahiert + erweitert `user-server-tool-defaults.ts`:
   ```ts
   export interface ResolveForToolArgs {
     readonly userId: string;
     readonly toolName: string;
     readonly args: Record<string, unknown>;
   }
   export interface AppliedDefault {
     readonly field: string;
     readonly from: 'user-input' | 'tool-default';
     readonly profile?: string;  // Phase C: gefüllt
   }
   export interface ResolveForToolResult {
     readonly resolvedInput: Record<string, unknown>;
     readonly defaultsApplied: AppliedDefault[];
   }
   resolveForTool(args): Promise<ResolveForToolResult>;
   ```
   Implementation Phase A: profile=`'default'` hardcoded. `subMcpName` aus Tool-Name via Helper `subMcpFromToolName(name, registry)`.

2. **`apps/server/src/mcp/protocol/transport.ts:handleToolsCall`** —
   - vor `registry.dispatch`: aufrufen wenn `env.toolDefaults` injiziert ist.
   - resolvedInput statt `params.arguments` weiterreichen.
   - `defaultsApplied` in `env.cancels`-Closure aufbewahren.

3. **`apps/server/src/mcp/protocol/registry.ts:DispatchArgs`** — neue optionale Property `defaultsApplied?: AppliedDefault[]`, wird ohne Logik durchgereicht in `ApprovalRequiredError`.

4. **`apps/server/src/mcp/protocol/tool.ts:ApprovalRequiredError`** — Konstruktor um `defaultsApplied` erweitert (optional, default `[]`).

5. **`apps/server/src/mcp/protocol/approval-resume.ts:enqueueApproval`** — schreibt `defaultsApplied` mit in die Approval-Row (Mig-0027-Spalte; **muss in Phase A schon angelegt sein** — Migration wird in Phase A mit-deployed). Damit Phase A nicht ohne Schema-Change auskommt, fügen wir hier vorab nur die `defaults_applied`-Spalte ein via mini-Migration **`0026a_approvals_defaults_applied.sql`** (renumbern beim Build wenn Migration 0026 schon belegt ist):
   ```sql
   ALTER TABLE pending_approvals
     ADD COLUMN defaults_applied JSONB NOT NULL DEFAULT '[]'::jsonb;
   ```
   (In 0027 wird dieser Schritt dann nur noch idempotent ergänzt.)

6. **`apps/server/src/services/approvals.ts:CreateApprovalArgs`** + Schema-Read-Path: `defaultsApplied` Field hinzu, in DB-Insert übernehmen, in `PendingApproval` zurückgeben.

7. **`apps/server/src/app-factory.ts:1240ff`** — `toolDefaults: ToolDefaultsService` an `McpTransportOptions.dispatchEnv` durchstecken. Service ist heute schon gebaut (Zeile 860).

8. **`apps/web/src/approval-sections.ts`** — neue Section "Defaults" rendern aus `defaults_applied`, pro Feld Badge `from profile=…` oder `from user-input`.

**Files (Test):**

- `apps/server/src/services/tool-defaults.test.ts` — Unit: resolve-Args-WIN, Empty-Defaults, Multi-Field, Args-undefined.
- `apps/server/src/mcp/protocol/transport.test.ts` (existiert) — Integration: tool/call mit existierendem Default merged correctly.
- `apps/server/tests/integration/approval-defaults.test.ts` (NEU) — Postgres-Container, full flow: PUT default → tools/call → Approval-Row enthält `defaults_applied[]` → Approve → Tool kriegt resolved args.

**Commits:**
- `feat(tool-defaults): wire resolver into transport (phase A)`
- `feat(tool-defaults): persist defaults_applied in approval (phase A)`
- `feat(pwa): render defaults attribution section (phase A)`

**Acceptance:** User mit gesetztem `gws.calendar.list / max_results = 25` und Call `gws.calendar.list({})` sieht im Approval `max_results = 25 (from profile=default)`. Nach Approve dispatched der Worker mit `max_results=25`.

---

### Phase B — Typed Storage + Schema-Aware UX (~6h)

**Ziel:** `value_text` → `value_json`. PWA Field-Picker konsumiert `inputSchema`. Pro Property das passende Widget.

**Files (Edit):**

1. **`apps/server/migrations/0027_tool_defaults_v2.sql`** — voll wie in §3. Phase-B-Anteil: `value_json`/`value_kind`-Spalten + Profile-Tabelle (Profile-API kommt erst in Phase C, aber Spalten und Default-Seed sind Phase-B-Voraussetzung). Hint-Tabelle wird in Phase E befüllt.

2. **`apps/server/src/services/tool-defaults.ts`** — `set()`-Signatur:
   ```ts
   set(args: {
     userId; subMcpName; profileName?: string;  // default 'default'
     toolName; fieldName;
     value: unknown;                            // typed
     valueKind: 'text'|'json'|'number'|'boolean'|'enum';
   }): Promise<ToolDefault>
   ```
   Validierung: `value` muss `valueKind` matchen. Storage: in `value_json` jsonb.

3. **`apps/server/src/services/tool-defaults.ts:validateAgainstSchema(toolInputSchema, fieldName, value)`** — Helper, der gegen das Zod-Schema des Tools prüft. Holt das Schema aus `ToolRegistry.get(name).inputSchema`. Native Tools haben Zod, kc_wrappers haben `z.unknown()` (siehe [kc_wrappers/index.ts:139](apps/server/src/tools/kc_wrappers/index.ts#L139)) — für KC-Tools wird gegen die **JSON-Schema-Variante** geprüft (kommt aus dem KC-Manifest via `manifest-client.ts`), Fallback `valueKind`-only-Check.

4. **`apps/server/src/routes/me/servers.ts:464-527`** — `PUT /v1/me/servers/:srv/tool-defaults/:tool/:field` body-Schema umstellen:
   ```ts
   z.object({
     value: z.unknown(),
     valueKind: z.enum(['text','json','number','boolean','enum']).default('json'),
     profile: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).default('default'),
     isSecret: z.boolean().optional(),
   })
   ```

5. **`apps/web/src/api.ts:setToolDefault`** — Signatur ändern auf typed `unknown` value + `valueKind` + `profile`.

6. **`apps/web/src/server-detail.ts:617-761`** — Field-Picker:
   ```ts
   // Statt freier <input type="text" placeholder="field_name">:
   const allFields = extractFieldsFromSchema(tool.inputSchema);
   const usedFields = new Set(existing?.keys());
   const remaining = allFields.filter(f => !usedFields.has(f.name));
   // <select> über remaining, dann pro selected field der passende Widget-Renderer:
   const widget = pickWidget(field.schema);
   // pickWidget returnt: TextInput | NumberInput | BooleanToggle | EnumSelect | JsonEditor
   ```

7. **`apps/web/src/components/schema-form.ts` (NEU)** — Widget-Renderer-Bibliothek:
   - `pickWidget(schema: JsonSchemaProperty): WidgetSpec`
   - `renderWidget(spec): { element, getValue, validate }`
   - 6 Widgets: TextInput, NumberInput, BooleanToggle, EnumSelect, DateTimeInput, JsonEditor (fallback)
   - Pure DOM, kein Framework — entspricht v2-Convention.

**Files (Test):**

- `apps/server/src/services/tool-defaults.test.ts` — Set-typed (number/bool/enum/json), validation failures, profile filter.
- `apps/web/tests/schema-form.test.ts` — Widget-Picking pro Schema-Shape, getValue-Roundtrip.
- `apps/server/tests/integration/tool-defaults-typed.test.ts` — PUT mit number-Value, GET, Resolver mergt mit korrektem Typ.

**Commits:**
- `feat(tool-defaults): migration 0027 (value_json, profile_name, hint table)`
- `feat(tool-defaults): typed set + schema validation`
- `feat(pwa): schema-form widget library`
- `feat(pwa): field-picker + typed widgets in defaults tab`

**Acceptance:** User wählt `max_results` aus Dropdown → NumberInput mit min=1 max=100 → speichert → DB hält `value_json = 25` (jsonb). Tool-Call kriegt `max_results: 25` (number, nicht "25").

---

### Phase C — Profile-Layer (~5h)

**Ziel:** User legt mehrere Profile an, aktiviert eines, kann pro Call überschreiben.

**Files (Edit):**

1. **`apps/server/src/services/tool-defaults.ts`** — neue Methoden:
   ```ts
   listProfiles(userId, subMcpName): Promise<Profile[]>;
   createProfile(args: {userId; subMcpName; profileName; description?; copyFrom?: string}): Promise<Profile>;
   activateProfile(userId, subMcpName, profileName): Promise<void>; // TX
   deleteProfile(userId, subMcpName, profileName): Promise<void>;   // refuse if active
   activeProfileFor(userId, subMcpName): Promise<string>; // 'default' fallback
   ```
   `resolveForTool()` erweitern um Profile-Resolution:
   ```ts
   const profile =
     extractProfileArg(args) ??               // __profile in args
     await perToolActiveProfile(userId, subMcpName, toolName) ??
     await activeProfileFor(userId, subMcpName);
   ```
   `__profile`-Arg wird aus `resolvedInput` gestripped bevor dispatched wird (sonst poisoniert es den Tool-Call).

2. **`apps/server/src/routes/me/servers.ts`** — neue Endpoints:
   ```
   GET    /v1/me/servers/:srv/default-profiles
   POST   /v1/me/servers/:srv/default-profiles      body: {name, description?, copyFrom?}
   POST   /v1/me/servers/:srv/default-profiles/:name/activate
   DELETE /v1/me/servers/:srv/default-profiles/:name
   ```
   Plus query-Param `?profile=` an `GET/PUT/DELETE /…/tool-defaults`.

3. **`apps/web/src/server-detail.ts:renderDefaultsTab`** — Profile-Switcher-Bar (Pill-Style, am Tab-Top). Active-Badge `●`. `[+ Neues Profil]` öffnet Modal mit copy-from-Dropdown.

4. **`apps/web/src/api.ts`** — neue Methoden `listProfiles/createProfile/activateProfile/deleteProfile`.

5. **`apps/server/src/mcp/protocol/transport.ts:handleToolsCall`** — `defaultsApplied[].profile` mit-persistieren in Approval-Row für WYSIWYS.

6. **`apps/web/src/approval-sections.ts`** — Badge erweitern: `from profile=prod` statt nur `from tool-default`.

**Reservierter Arg-Name `__profile`:**
- Im Resolver gestripped vor Dispatch.
- Linter (siehe `scripts/lint-tools.mjs` falls vorhanden, sonst neu in Phase C) lehnt Tool-Definitionen ab, die `__profile` als Property im Schema deklarieren. Fail-CLOSED.

**Files (Test):**

- `apps/server/src/services/tool-defaults.test.ts` — Profile-CRUD, activate-Konflikt (zwei active gleichzeitig), copy-from, delete-active rejected.
- `apps/server/tests/integration/tool-defaults-profiles.test.ts` — DB-Beispiel mit prod+test, Tool-Call mit `__profile`, Approval-Row enthält `profile='test'`.
- `apps/web/tests/profile-switcher.test.ts` — Switch updated UI + reload.

**Commits:**
- `feat(tool-defaults): profile CRUD service`
- `feat(tool-defaults): __profile arg + per-call override`
- `feat(tool-defaults): REST profile endpoints`
- `feat(pwa): profile switcher + new-profile modal`

**Acceptance (DB-Story):** User legt `prod` (active) + `test`. `db.query({sql: "…"})` nimmt `prod`-Defaults. `db.query({__profile: "test", sql: "…"})` nimmt `test`-Defaults. Approval-Card zeigt Profile-Source pro Field. Alice und Bob haben unabhängige `prod`-Profile (RLS-isoliert).

---

### Phase D — LLM-Initiation: `tools.help` + `_meta.defaults_summary` (~3h)

**Files (Edit):**

1. **`apps/server/src/tools/tool-help.ts` (NEU)** — neues natives Tool:
   ```ts
   {
     name: 'tools.help',
     sensitivity: 'read',
     inputSchema: z.object({ name: z.string().min(1).max(128) }).strict(),
     async execute(ctx, {name}) {
       const meta = registry.get(name);
       if (!meta) throw HttpError.notFound(`tool '${name}' not found`);
       const subMcp = subMcpFromToolName(name);
       const active = await toolDefaults.activeProfileFor(ctx.userId, subMcp);
       const effective = await toolDefaults.listByTool(ctx.userId, subMcp, name, active);
       const hints = await toolDefaults.listHintsByTool(ctx.userId, subMcp, name);
       const profiles = await toolDefaults.listProfiles(ctx.userId, subMcp);
       const schemaFields = extractFieldsFromSchema(meta.inputSchema);
       const withDefault = new Set(effective.map(d => d.fieldName));
       return {
         tool: { name: meta.name, description: meta.description, inputSchema: meta.inputSchema },
         defaults: {
           active_profile: active,
           effective: Object.fromEntries(effective.map(d => [d.fieldName, d.value])),
           fields_with_defaults: [...withDefault],
           fields_without_defaults: schemaFields.map(f=>f.name).filter(f => !withDefault.has(f)),
         },
         hints: Object.fromEntries(hints.map(h => [h.fieldName, h.hintText])),
         available_profiles: profiles.map(p => ({ name: p.profileName, active: p.isActive })),
       };
     }
   }
   ```
   Registriert in `tools/index.ts` neben den anderen.

2. **`apps/server/src/mcp/protocol/transport.ts:ToolsList`** — `_meta`-Anreicherung pro Tool:
   ```ts
   case McpMethods.ToolsList: {
     const allTools = env.registry.list();
     // ... existing subscription filter ...
     const summary = env.toolDefaults
       ? await env.toolDefaults.summarizeForUser(env.principal.userId)
       : new Map();   // Map<toolName, {active_profile, fields_with_defaults}>
     const enriched = tools.map(t => ({
       ...t,
       annotations: {
         ...t.annotations,
         defaults_summary: summary.get(t.name) ?? null,
       },
     }));
     return rpcSuccess(req.id, {tools: enriched});
   }
   ```
   `summarizeForUser` macht **eine** Aggregat-Query (kein N+1):
   ```sql
   SELECT sub_mcp_name, tool_name, profile_name,
          array_agg(field_name) AS fields
     FROM user_server_tool_defaults
     JOIN user_tool_default_profiles USING (user_id, sub_mcp_name, profile_name)
    WHERE user_id = $1 AND user_tool_default_profiles.is_active = TRUE
    GROUP BY 1,2,3
   ```
   Result wird per-Request gecached (Lambda-lokal). Cache-TTL = Request-Lifetime; kein cross-request-Cache (RLS-Sicherheit).

3. **`apps/server/src/tools/index.ts`** — `makeToolHelpTool(deps)` registrieren.

**Files (Test):**

- `apps/server/src/tools/tool-help.test.ts` — Read-Tool-Verhalten, unknown-tool-404, hints + profiles richtig zusammengefasst.
- `apps/server/tests/integration/tools-list-meta.test.ts` — Pre/Post set-default, `defaults_summary` ändert sich entsprechend.

**Commits:**
- `feat(tool-defaults): tools.help native tool`
- `feat(tool-defaults): _meta.defaults_summary in tools/list`

**Acceptance:** Claude ruft `tools.help("gws.calendar.list")` → response enthält `effective.max_results: 25`, `available_profiles: [{name:"default", active:true}]`. Im selben Session `tools/list` zeigt `annotations.defaults_summary` pro Tool.

---

### Phase E — Hints + Elicitation (~5h)

**Files (Edit):**

1. **`apps/server/src/services/tool-defaults.ts`** — Hint-Methoden:
   ```ts
   listHintsByTool(userId, subMcpName, toolName): Promise<Hint[]>;
   setHint(args: {userId; subMcpName; toolName; fieldName; hintText}): Promise<Hint>;
   removeHint(args: {userId; subMcpName; toolName; fieldName}): Promise<void>;
   ```

2. **`apps/server/src/routes/me/servers.ts`** — Endpoints:
   ```
   GET    /v1/me/servers/:srv/tool-hints
   PUT    /v1/me/servers/:srv/tool-hints/:tool/:field    body: {hintText}
   DELETE /v1/me/servers/:srv/tool-hints/:tool/:field
   ```

3. **`apps/server/src/tools/tool-defaults-hints.ts` (NEU)** — MCP-Tools (`tool_defaults.hint.set/remove`) für LLM-Schreibpfad. write-Sensitivity, Approval.

4. **`apps/web/src/server-detail.ts:renderToolDefaultsBlock`** — 💡-Icon pro Field/Property → Inline-Editor.

5. **`apps/server/src/mcp/protocol/transport.ts:handleToolsCall`** — Elicitation-Hook:
   ```ts
   if (
     tool.sensitivity !== 'read' &&
     defaultsApplied.filter(d => d.from === 'tool-default').length === 0 &&
     hasHintsForTool &&
     env.clientCapabilities?.elicitation &&
     await env.userSettings.elicitOnMissingDefaults(env.principal.userId)
   ) {
     return rpcSuccess(req.id, {
       elicitation_required: {
         schema: filterSchemaToMissingFields(tool.inputSchema, args),
         hints,
         profiles: await toolDefaults.listProfiles(...),
       },
     });
   }
   ```
   Capability-Check kommt aus `handleInitialize`-Phase — speichern wir in `env.clientCapabilities` (neuer Field auf `DispatchEnv`). Default OFF (User-Setting `elicit_on_missing_defaults: boolean` in `user_settings`-Tabelle — falls die Tabelle nicht existiert, mini-Migration 0028).

6. **`apps/server/src/schema/postgres/user-settings.ts`** — entweder bestehendes Schema erweitern oder Mig 0028 anlegen.

**Files (Test):**

- `apps/server/src/services/tool-defaults.test.ts` — Hint-CRUD.
- `apps/server/tests/integration/elicitation.test.ts` — Capability-Mock, DANGER-Tool ohne Default + Hint → elicitation_required; ohne Hint → keine Elicitation; mit Capability=false → Approval-Path.

**Commits:**
- `feat(tool-defaults): hints CRUD + REST + MCP tools`
- `feat(tool-defaults): elicitation hook for danger-without-default`
- `feat(pwa): hint editor inline`

**Acceptance:** User setzt Hint `temperature: "0.0 deterministisch .. 2.0 wild"` für `llm.ask`. Call `llm.ask({prompt: "…"})` ohne aktiven temperature-Default → Hub gibt `elicitation_required` mit Hint zurück (wenn Client capability hat). Sonst Standard-Approval.

---

### Phase F — BC + Cleanup (~2h)

**Files (Edit):**

1. **`apps/server/src/tools/prefs-tools.ts`** — Description-Banner `[DEPRECATED 2026-06-15: use tool_defaults.*]`. Code-Pfad unverändert, aber implementiert intern via neuer ToolDefaultsService (Brücke).

2. **`apps/server/src/routes/me/servers.ts`** — `/v1/prefs`-Route (heute 404) NICHT neu montieren — stattdessen 410 Gone mit `Location`-Header zu `/v1/me/servers/<srv>/tool-defaults`.

3. **`apps/web/src/defaults-tab.ts`** — die alte `#/defaults`-Tab entfernen oder redirect-only-Stub: bei Mount → `window.location.hash = '#/tools/servers'`.

4. **`apps/web/src/main.ts`** — `#/defaults` BC-Redirect (existiert teilweise, prüfen).

5. **`apps/server/migrations/0030_drop_user_tool_prefs.sql`** (vorbereitet, nicht apply-en):
   ```sql
   -- Apply mind. 30 Tage nach 0027 Deploy:
   -- DROP TABLE IF EXISTS user_tool_prefs;
   -- DROP TABLE IF EXISTS user_prefs;   -- totes Schema (Mig 0008)
   ```
   Im Plan dokumentiert, im Repo als `.sql.deferred`-File abgelegt damit kein versehentlicher `npm run migrate` das droppt.

**Commits:**
- `chore(tool-defaults): deprecate prefs.* with banner`
- `chore(tool-defaults): redirect #/defaults to servers list`
- `chore(tool-defaults): document 0030 drop migration (deferred)`

**Acceptance:** Alter `prefs.set` MCP-Call funktioniert noch (BC), schreibt aber in `user_server_tool_defaults`. PWA leitet `#/defaults` zur Server-Liste.

---

## 6. Test-Plan (Summary)

| Schicht | Tool | Wo | Was |
|---|---|---|---|
| Unit | vitest | `services/tool-defaults.test.ts` | resolveForTool (Args-WIN, Profile, missing), CRUD profile/hints, validateAgainstSchema. |
| Unit | vitest | `tools/tool-help.test.ts` | tools.help shape, missing-tool. |
| Unit | vitest | `web/tests/schema-form.test.ts` | Widget-Selection pro Schema-Property. |
| Integration | testcontainers | `tests/integration/approval-defaults.test.ts` | PUT default → tools/call → Approval-Row → Approve → Worker-Dispatch. |
| Integration | testcontainers | `tests/integration/tool-defaults-profiles.test.ts` | Multi-Profile, __profile override, two-user-RLS-isolation. |
| Integration | testcontainers | `tests/integration/elicitation.test.ts` | Capability-on/off, hints-present/absent. |
| Smoke (E2E) | pilot-smoke.sh | `scripts/pilot-smoke.sh` | erweitern: PUT default, list, set profile=test, call, verify args. |

**Coverage-Ziele:** Service ≥ 90% lines; Routes ≥ 80%; transport-Hook 100% des neuen Codes (kritischer Security-Pfad).

**RLS-Test (kritisch — User-Forderung "jeder User hat seine eigene Konfiguration"):**
```ts
it('user B cannot read user A defaults via direct query', async () => {
  await db.transaction(userA, async (s) => s.query(`INSERT ...`));
  await db.transaction(userB, async (s) => {
    const rows = await s.query(`SELECT * FROM user_server_tool_defaults`);
    expect(rows).toHaveLength(0);    // RLS hides A's rows
  });
});
it('activating profile in user A does not affect user B', async () => { … });
it('user B cannot DELETE user A profile via raw SQL', async () => { … });
```
Pro neuer Tabelle drei RLS-Tests (read/write/cascade).

---

## 7. Rollout / Deploy-Sequenz

Per User-Konvention `[deploy]`-Tag triggert Fly.io-Job. Migrations laufen im `release_command` der `fly.toml` idempotent.

| Schritt | Commit-Subject | Risiko | Rollback |
|---|---|---|---|
| 1 | `feat(tool-defaults): phase A wire-in + approval column [deploy]` | klein — additive Spalte, neuer optionaler Hook | Service-Disable in app-factory (feature-flag) |
| 2 | `feat(tool-defaults): phase B migration 0027 + typed storage [deploy]` | mittel — PK-Change auf existing Tabelle | Rollback-Migration 0027r vorhalten (drop new cols, restore old PK) |
| 3 | `feat(tool-defaults): phase B pwa schema-form [deploy]` | klein — PWA only | Asset-Revert |
| 4 | `feat(tool-defaults): phase C profiles [deploy]` | klein — Profile-Code | Code-Revert |
| 5 | `feat(tool-defaults): phase D tools.help + meta [deploy]` | klein | Tool-Unregister |
| 6 | `feat(tool-defaults): phase E hints + elicit [deploy]` | mittel — neuer transport-Branch | Settings-Default OFF |
| 7 | `chore(tool-defaults): phase F deprecate prefs [deploy]` | klein | BC-Tools bleiben — keine User-Wirkung |
| 8 (>30d später) | `feat(schema): apply 0030 drop deprecated [deploy]` | klein | Restore from R2-Backup |

**Feature-Flag (Phase A):** In `app-factory.ts` wird der Resolver-Hook nur dann eingehängt wenn `process.env.TOOL_DEFAULTS_RESOLVE === '1'` (Default ON nach Smoke). Damit kann der User auf prod ad-hoc deaktivieren ohne Revert.

**Pre-push-Gate:** Pre-push-Hook (siehe v1-Konvention) läuft pilot-smoke gegen Pilot-Stage falls vorhanden. Hier: lokal `npm run test` + `npm run typecheck` zwingend grün.

**Cross-Repo:** Keine KC2-Änderungen nötig. KC-Wrappers brauchen aber `inputSchema` aus dem KC-Manifest für Phase B Validierung — bereits via `manifest-client.ts` verfügbar. Wenn KC2-Manifest später Annotations aktualisiert, läuft Resolver weiter (lazy validation).

---

## 8. Per-User-Isolation — explizite Garantie-Liste

User-Forderung "Jeder User hat seine eigene Konfiguration" zerlegt:

| Garantie | Mechanismus |
|---|---|
| User A sieht User B's Defaults **nicht** | RLS-Policy `current_setting('app.current_user')` auf allen vier neuen Tabellen + `pending_approvals.defaults_applied` |
| User A kann User B's Defaults **nicht** schreiben | RLS `WITH CHECK` + `db.transaction(userId, ...)` setzt `app.current_user` |
| Profile-Names kollidieren pro User unabhängig | PK `(user_id, sub_mcp_name, profile_name)` — Alice's `prod` ist eine andere Row als Bob's `prod` |
| Aktiv-Profil ist pro `(user, sub_mcp_name)` skopiert | Partial-Unique-Index `WHERE is_active=TRUE` ist per-user-skopiert (PK enthält `user_id`) |
| Bootstrap: neuer User hat **leere** Default-Menge | Seed in Mig 0027 läuft nur über existierende `user_server_tool_defaults`-Rows; neue User starten leer mit Auto-`default`-Profil bei erstem `set` |
| Kein Operator-/Tenant-/Group-Default-Set | Keine `tenant`-/`group`-Spalte. PrefsService-`scope='tenant'` (Mig 0009) wird in Phase F deprecated — nicht migriert. |
| Cross-User-Test im Integration-Set | siehe §6 RLS-Test |
| `tools/help` zeigt nur User-eigene Defaults | Service nutzt `db.transaction(userId, …)`; kein cross-user-leak in `_meta.defaults_summary` (Cache ist request-lokal) |
| `__profile`-Argument referenziert nur eigene Profile | Resolver lädt Profile via `userId`-scoped query; unbekannte profile_name → Fehler 400, kein fallback auf "default" (sonst silent-mismatch) |

**Multi-Tenant-Ausblick:** Sollten irgendwann mehrere Family-Member dieselben Defaults teilen wollen (Group-Sharing-Pattern aus KC2): eigener Plan, eigener Datentyp (`user_tool_default_profiles.shared_with_group_id`). Nicht Teil dieses Plans.

---

## 9. Beispiel-Walkthrough — DB-Profile-Story (vollständig)

### Setup (Alice)

```
PWA #/tools/servers/db/defaults
  1. [+ Neues Profil] → name=prod, description=Produktion
     POST /v1/me/servers/db/default-profiles
          body: {name:"prod", description:"Produktion"}
     → Approval (tool_defaults.profile.create)
     → DB: user_tool_default_profiles row (alice_id, 'db', 'prod', '', false)

  2. Field-Picker auf db.query:
     connection_string [TextInput] → "postgres://prod-host/main"
     PUT /v1/me/servers/db/tool-defaults/db.query/connection_string
          body: {value:"postgres://prod-host/main", valueKind:"text", profile:"prod"}
     → Approval (tool_defaults.set)
     → DB: user_server_tool_defaults row

  3. Field-Picker auf db.query:
     read_only [BooleanToggle ON]
     PUT /v1/me/servers/db/tool-defaults/db.query/read_only
          body: {value:true, valueKind:"boolean", profile:"prod"}

  4. [+ Neues Profil] → name=test, copyFrom=prod
     → DB hat jetzt zwei Profile, beide ihre Rows

  5. Wechsel zu test, editiere connection_string → localhost
                       editiere read_only → OFF

  6. Profil-Switcher: aktiviere [prod ●]
     POST /v1/me/servers/db/default-profiles/prod/activate
     → DB: prod.is_active=TRUE (TX setzt erst test.is_active=FALSE)
```

### Runtime (Alice)

```
LLM: tools/call db.query { sql: "SELECT 1" }
Hub: resolveForTool:
       userId = alice
       subMcpName = 'db'
       profile = activeProfileFor(alice, 'db') = 'prod'
       loadDefaults(alice, 'db', 'prod', 'db.query') →
         [{field:connection_string, value:"postgres://prod-…"},
          {field:read_only,         value:true}]
       merge({sql}, defaults) →
         resolvedInput = {connection_string:"postgres://prod-…", read_only:true, sql:"SELECT 1"}
       defaultsApplied = [
         {field:sql,                from:'user-input'},
         {field:connection_string,  from:'tool-default', profile:'prod'},
         {field:read_only,          from:'tool-default', profile:'prod'},
       ]
Hub: registry.dispatch → write → ApprovalRequiredError
Hub: enqueueApproval persists toolInput=resolvedInput, defaults_applied=…
Hub: response {approval_required, approval_id, display_rendered}
PWA: pollt → zeigt 3-Felder-Card mit Profile-Badges → Touch-ID approve
Hub: resumeApproval → dispatch mit toolInput → Worker
```

### Runtime mit Override (Alice)

```
LLM: tools/call db.query { __profile:"test", sql:"SELECT 1" }
Hub: profile = 'test' (from __profile arg)
     resolvedInput = {connection_string:"postgres://localhost…", read_only:false, sql:"SELECT 1"}
     // __profile wird vor Dispatch gestripped
     defaultsApplied = [
       {field:__profile,         from:'user-input'},        // sichtbar in Approval
       {field:sql,               from:'user-input'},
       {field:connection_string, from:'tool-default', profile:'test'},
       {field:read_only,         from:'tool-default', profile:'test'},
     ]
```

### Runtime (Bob, anderer User)

```
LLM (Bob): tools/call db.query { sql:"SELECT 1" }
Hub: resolveForTool(userId=bob, …)
     → DB-Query unter `app.current_user=bob`
     → sieht NUR Bob's profiles (RLS); Bob hat keine → 'default'-Profil
     → defaults = []
     → resolvedInput = {sql:"SELECT 1"}
     → Worker fail't ohne connection_string (richtig — Bob hat noch nichts konfiguriert)
```

### Runtime mit `tools.help` (Alice)

```
LLM: tools/call tools.help { name:"db.query" }
Hub: response {
  tool: {name, description, inputSchema},
  defaults: {
    active_profile: "prod",
    effective: { connection_string:"postgres://prod-…", read_only:true },
    fields_with_defaults: ["connection_string","read_only"],
    fields_without_defaults: ["sql","timeout_ms"],
  },
  hints: { timeout_ms: "default 30s — höher für Reports" },
  available_profiles: [
    {name:"prod", active:true},
    {name:"test", active:false},
  ]
}
LLM: "Aktuell prod (read-only). Für test: db.query({__profile:'test', sql:…})."
```

---

## 10. Entschieden 2026-05-18

1. **`__profile`-Schutz:** Lint (`scripts/lint-tools.mjs` neu) **und** Runtime-Reject in `registry.register()` (fail-CLOSED, Tool wird abgelehnt + WARN-Log statt Server-Boot-Failure). Plus Reservierungs-Liste `['apps','docs','skills','kc','tools','prefs','tool_defaults','groups','native','memorize']` für `POST /v1/me/servers`-Validator und `subMcpFromToolName`.
2. **Elicit-Default-State:** OFF. Setting `user_settings.elicit_on_missing_defaults: boolean` (Default FALSE) in Phase E. PWA `#/settings/agent` Toggle + Onboarding-Toast beim ersten Hint.
3. **Sub-MCP-Name-Extraktion:** Heuristik `subMcpFromToolName(name, subMcpServerNames)`:
   - kein `.` → `'native'`
   - prefix in `subMcpServerNames` → prefix
   - prefix `'kc'` → `'knowledge2'`
   - sonst → `'native'`
   Reservierungs-Liste (siehe ①) verhindert Konflikt-Server-Namen.
4. **Secret-Refs:** Out-of-scope. Soft-Block in `tool_defaults.set` und REST-PUT-Handler:
   ```ts
   const SECRET_FIELD_RE = /_(key|token|secret|password)$/i;
   if (SECRET_FIELD_RE.test(fieldName) && valueKind === 'text') {
     throw HttpError.badRequest('invalid_request',
       `field '${fieldName}' sieht nach Secret aus — verwende den Auth-Tab des Servers, nicht Tool-Defaults.`);
   }
   ```
5. **Drift-Detection:** `user_server_tool_defaults.orphan_since BIGINT NULL` (Mig 0027). Resolver checked beim Merge `tool.inputSchema` und lazy-write's `orphan_since=now()` bei Miss; bei Match → unset. PWA-Tab rendert orphan-Rows mit roter Border + Tooltip + 🗑-Button-Highlight. Kein Cron-Sweep.

**Konsequenzen für die Migration und Phasen:**
- Mig 0027 hat `orphan_since BIGINT NULL` zusätzlich (§3 oben aktualisiert).
- Phase A `registry.register()` reject auf `__profile`-Property + Reservierungs-Liste.
- Phase A Resolver schreibt `orphan_since` lazy.
- Phase A `scripts/lint-tools.mjs` neu (Tool-Schema-Linter).
- Phase B `tool_defaults.set` + REST-PUT: Soft-Block für Secret-Felder.
- Phase E User-Setting + Toggle.

---

## 11. Risiken / Tradeoffs

| Risiko | Wahrscheinlichkeit | Mitigation |
|---|---|---|
| Mig 0027 PK-Change lockt `user_server_tool_defaults` während Deploy | klein (Tabelle ist klein, single-user-Family-Mode) | additive Spalten erst, PK-Swap als letzter Step der Migration in einer TX |
| WYSIWYS-Drift bei Approval-Resume | klein | `toolInput`+`defaults_applied` in der Row, Resume re-resolved nicht |
| Sub-MCP-Worker erwartet anderen Typ als gespeichert | mittel | Phase B Validation gegen `inputSchema`; bei KC-Wrappers Fallback auf Manifest-JSON-Schema |
| `__profile`-Schema-Pollution | klein | Linter + Runtime-Reject |
| MCP-Elicitation-Capability fragil | mittel | OFF by default, ausschaltbar per User-Setting |
| `_meta.defaults_summary` macht `tools/list` langsamer | klein | one aggregate query, request-lokaler Cache |
| User droppt Profil mit aktiven Defaults | klein | Bestätigungs-Dialog in PWA + Refuse-when-active in Service |

---

## 12. Nicht-Ziele

- **Tenant-/Group-Sharing** von Defaults. Plan adressiert nur Per-User.
- **Conditional Defaults** (`wenn x=A dann y=B`).
- **Sensitivity-Override via Default** (Default kann NICHT eine `danger`-Annotation auf `write` senken).
- **Auto-Suggest aus Tool-Call-History** (LLM lernt Default-Werte aus früheren Calls) — sehr cool, aber später.
- **Migrate `user_tool_prefs` (Mig 0009) Daten** — Tabelle ist im jetzigen v2-Stand ungenutzt (kein User-Caller); Daten-Migration nicht nötig.

---

## 13. Definition-of-Done

- [ ] Mig 0027 angewendet auf prod-Postgres; Schema-Diff in `terraform/`-Dump bestätigt
- [ ] `resolveForTool` aktiv im transport-Pfad; Integration-Test grün
- [ ] PWA Field-Picker rendert min. 5 Widget-Typen
- [ ] Mindestens 1 Multi-Profile-Setup von Alice live demonstriert (prod+test mit Profile-Switch)
- [ ] `tools.help` callable; Response-Shape matched §5 Phase-D
- [ ] `tools/list._meta.defaults_summary` enthält Aggregat
- [ ] Hint-Editor live; mind. 1 Hint im Demo gesetzt
- [ ] Elicitation auf DANGER-without-default validiert mit Capability-Mock
- [ ] BC: `prefs.set` läuft, schreibt aber neue Surface
- [ ] RLS-Tests bestehen Cross-User-Read/Write/Delete
- [ ] Smoke (`pilot-smoke.sh`) erweitert + grün
- [ ] Doc-Update: `docs/STATUS.md`, `CLAUDE.md`-Plan-Index, dieser File auf ✅
