# PLAN: Document Linking — Agent-readable Cross-References

> **Status:** ⚠️ Konzept + Impl-Plan (2026-05-17, **User-Decisions-Locked** §10.5). Code: 0 %. Storage-Layer (object_refs) existiert in KC2 ([src/storage/refs.ts](https://github.com/axel-rogg/mcp-knowledge2/blob/main/src/storage/refs.ts)). Konsumenten (Adapter, Tool-Responses, PWA, AppsService) noch nicht.
>
> **Scope:** Cross-Repo. Storage + Tool-Surface in `mcp-knowledge2`. Consumer (Adapter, PWA-Storage-Detail, kc_wrappers) in `mcp-approval2`. Wire-Format-Drift via `apps/server/tests/contract/` fixiert.
>
> **Treiber:** User-Feedback 2026-05-17 — „Die Verlinkung der Dokumente ist sehr wichtig. Alle Dokumente sollen verlinkt werden können. Der AI Agent muss das sehen wenn er ein Dokument über MCP-Server lädt." Plus: Migration v1→v2 hat Object-Refs (Skill ↔ Resource-Doc-Graph) nicht übernommen — Skills + Resources liegen verwaist.

---

## 1. Problem

Ein Knowledge-Store wie KC2 hat Wert weil Inhalte zusammenhängen — ein Skill verweist auf Resource-Docs, ein Recipe auf verwandte Recipes, eine Decision auf das ADR das sie ersetzt. Aktuell:

- `object_refs`-Tabelle existiert in KC2 (Schema + Storage + 3 MCP-Tools `objects.usages` / `add_ref` / `remove_ref`)
- `role`-Feld ist **free-form** `text` ohne Vokabular
- `objects.read` liefert die Refs **nicht** mit — der Agent muss sie via separatem `objects.usages`-Call erfragen, weiß aber nicht dass es sich lohnt
- `search`-Hits zeigen keine verwandten Docs an
- v1-PWA hatte `docs.usages` + "used_by[]"-Annotation in Search-Hits, v2-PWA hat das noch nicht
- Anthropic-Skill-Pattern (Manifest + lazy-loaded Resource-Files) wird **nirgends** abgebildet — Skill-Docs sind in v2 isolierte Markdown-Files ohne Resource-Verknüpfung

Effekt: Agent (Claude) kennt die Beziehungen nicht, lädt Docs einzeln, verfehlt zusammenhängenden Kontext.

## 2. Research-Synthese (Stand 2026, Quellen am Ende)

Sechs Erkenntnisse aus Primary-Sources (MCP-Spec 2025-11-25, Anthropic Skills, GraphRAG/HippoRAG/GraphReader-Papers):

1. **MCP-Spec hat zwei native Primitiven:** `resource_link` (Pointer, kein Body) vs eingebettete `resource` (Pointer + Body inline). Plus `structuredContent` für JSON-Side-Channel. Es gibt **kein** natives Predicate für Relations — wir müssen ein eigenes Vokabular tragen.
2. **Anthropic Skills lazy-loaden Resources via Natural-Language-Hints** (`"Wenn Du PDF-Forms brauchst, lies FORMS.md"`). Pfad-basiert, kein JSON-Refs-Block. Agent ruft `read_file()` selbständig. **Keine** Cross-Skill-References definiert — jeder Skill ist Insel.
3. **GraphRAG/HippoRAG lohnen erst ab ~10k Docs** mit multi-hop Queries die Vocabulary-übergreifend sind. Bei <1000 Docs ist Flat-FTS+Vector-Hybrid (was KC2 schon hat) gleich gut. **Anti-Recommendation: Kein voller Graph-RAG.**
4. **GraphReader-Pattern** (Agent traversiert mit expliziten Tools `read_chunk` / `read_neighbor`) ist 1:1 was wir mit `objects.read` + `objects.usages` schon können — nur unterdokumentiert. Agent braucht Hinweis dass es sich lohnt zu traversieren.
5. **„Link by default, embed on demand"** (Anthropic Code-Execution-MCP-Post 2025): defensives Embedding kostete 150k Tokens, lazy-Pattern 2k. 98.7 % Ersparnis.
6. **Typed-Role-Vocabulary**: 3–7 geschlossene Rollen schlagen sowohl untyped `[[wikilinks]]` (Obsidian) als auch volles Schema.org (RDF). Sweet-Spot ist eine **kleine, geschlossene Liste von Verben** die der LLM in English/Deutsch direkt versteht.

Quellen-Block am Ende der Datei.

## 3. Konzept — die 5 Bausteine

### 3.1 Geschlossenes Rollen-Vokabular

Vier kanonische Rollen (Erweiterung später möglich, aber bewusst klein gehalten):

| Rolle | Semantik | Eager-Load durch Agent? | UI-Label DE |
|---|---|---|---|
| `resource` | „Diese Datei gehört zu mir." Skill → Resource-Doc, Manifest → Asset, Recipe → Zutaten-Bild. | **Ja** — Agent erwartet dass Resource fast immer relevant ist wenn Parent geladen wird. | „Anhang" |
| `references` | „Verwandt, aber optional." See-also-Verweis, weiterführende Lektüre. | **Nein** — nur wenn Query-spezifisch relevant. | „Siehe auch" |
| `part_of` | Inverse von `resource`. „Ich bin Kapitel/Bestandteil von X." Für Navigation rückwärts. | Nein (das Parent zu laden ist seltener nötig als andersrum). | „Teil von" |
| `depends_on` | „Funktional abhängig." Skill-A braucht Skill-B's Output. Recipe braucht anderes Recipe. | **Ja** wenn der Agent das Parent ausführt (nicht nur liest). | „Benötigt" |

**Speicher-Format:** Wie heute — `object_refs(from_id, to_id, role, meta_json)`. `role`-Spalte bleibt `text` (kein Enum) für Forward-Compat, aber Tool-Surface validiert gegen die geschlossene Liste. Unbekannte Rollen aus älteren Daten werden als `references` (Default-Soft) interpretiert.

**Was bewusst NICHT in der Liste ist:**
- `supersedes` / `replaced_by` — Versioning ist via `archived=true` + `meta.replacedBy=<id>` in der Owner-Box besser modelliert (kein Edge nötig).
- `tag` / `category` — dafür gibt's `object_tags`.
- Schema.org-Vollvokabular (`dependsOn`, `isPartOf`, `mainEntity`, `mentions`...) — Over-Engineering ohne Use-Case.

### 3.2 Tool-Response-Pattern „Link by default, embed on demand"

**`objects.read` (default-call):**

```json
{
  "result": {
    "id": "01H...",
    "subtype": "skill_manifest",
    "title": "PDF-Handling",
    "summary": "Skill für PDF-Operations: Form-Fill, Extract, Merge. Resources: API-Reference + Forms-Guide + Examples.",
    "body": "<full markdown body>",
    "bodyEncoding": "utf8"
  },
  "refs": {
    "outgoing": [
      { "role": "resource",   "id": "01J...", "subtype": "doc", "title": "PDF-API-Reference", "summary": "Vollständige pdfplumber + PyPDF2 API-Übersicht. ~4 KB.", "uri": "kc://object/01J..." },
      { "role": "resource",   "id": "01K...", "subtype": "doc", "title": "PDF-Forms-Guide",   "summary": "Schritt-für-Schritt Form-Fill mit Beispielcode.",        "uri": "kc://object/01K..." },
      { "role": "references", "id": "01L...", "subtype": "recipe", "title": "Invoice-PDF-extrahieren", "summary": "Recipe das diesen Skill anwendet auf Rechnungen.", "uri": "kc://object/01L..." }
    ],
    "incoming": [],
    "truncated": { "outgoing": 0, "incoming": 0 }
  }
}
```

**Eigenschaften:**
- Refs werden **immer mitgeliefert** wenn `objects.read` aufgerufen wird (kein Opt-In nötig — sonst sieht der Agent sie nicht).
- Pro Ref: `role`, `id`, `subtype`, `title`, **`summary` (Pflicht, 120–300 chars)**, `uri`.
- **`summary` ist Pflicht** — ohne Summary lädt der Agent defensiv und der Lazy-Load-Vorteil verschwindet (siehe Pattern 4 in 3.4).
- Body der refs wird **nicht** mitgeladen.
- Cap auf jeweils 5 outgoing + 5 incoming, mit `truncated.outgoing` / `truncated.incoming` als Hinweis. Über 5? → User kann's in der PWA sehen; Agent kann `objects.usages` ohne Cap nachladen.

**Opt-In zum Eager-Embed via `?include_bodies=resource`:**

```json
"refs": {
  "outgoing": [
    { "role": "resource", "id": "01J...", "subtype": "doc", "title": "...", "summary": "...", "uri": "kc://...", "body": "<full body>" }
  ]
}
```

Nur Rollen die im Query stehen werden gebodyed. Default: nichts.

**`search`-Response:**

```json
{
  "hits": [
    {
      "id": "01H...", "title": "PDF-Handling", "summary": "...", "score": 0.87, "uri": "kc://...",
      "used_by": [
        { "role": "part_of", "id": "01M...", "title": "Office-Workflows-Skill-Pack", "summary": "..." }
      ],
      "used_by_truncated": 0
    }
  ]
}
```

Das ist die v1-„used_by[]"-Annotation, generalisiert für alle Rollen. Cap auf 2 used_by-Einträge pro Hit (wie v1), 0.7×-Score-Penalty bei sub-docs damit Top-Level vorne bleibt (Übernahme aus v1 PLAN-search-subdocs).

### 3.3 `kc://`-URI-Schema

Universeller Identifier für Refs, in MCP `resource_link.uri` und im Body als Markdown-Link nutzbar.

| Form | Bedeutung |
|---|---|
| `kc://object/<uuid>` | Konkretes Objekt by ID |
| `kc://object/<uuid>#<anchor>` | Anchor-Sprung innerhalb (optional, future) |
| `kc://search?q=<query>&subtype=<x>` | Saved-Search-Link (future) |

**Markdown-Body-Konvention:** Wenn Autor (Mensch oder Agent) im Body explizit verlinken will:
```markdown
Siehe [PDF-API-Reference](kc://object/01J...) für Details.
```

Der Renderer in der PWA (`apps/web/src/renderers/markdown.ts`) resolved `kc://`-Links zu `#/storage/<uuid>`. Der Agent erkennt das Schema und kann via `objects.read(uuid)` nachladen.

**Wichtig:** Die strukturierten `refs.outgoing[]` sind die **Source-of-Truth**. Inline-Markdown-Links sind nur UI-Komfort und werden **nicht automatisch in `object_refs` gespiegelt** (das wäre Magic + Sync-Hell — explizit lassen).

### 3.4 Mandatory-Summary-Contract

Jedes Objekt das als `to_id` in einem Ref vorkommen **kann** muss eine `description` (= `summary`, 120–1500 chars) tragen. Konkret:

- `objects.create` mit `subtype ∈ { 'doc', 'skill_manifest', 'recipe', ... }` → `description` ist **soft-recommended**.
- `objects.add_ref` ohne `description` auf `to_id` → Warning im Response, aber kein Block (Migration-Forgiveness). Plus: Agent bekommt `summary: null`-Flag, weiß dass er ggf. defensiv lädt.
- `docs.update_summary` (v1-Tool, in v2 noch zu portieren) füllt fehlende Summaries nach.
- PWA Storage-Detail-View hat schon Edit-Pencil für Summary (v1 PLAN-docs-embedding). In v2 portieren.

**Begründung:** Wenn der Agent in `refs.outgoing[]` keinen Summary sieht, ist seine optimale Strategie „lad's halt, vielleicht ist's relevant". Das frisst den Lazy-Load-Vorteil. Summary ist der Vertrag.

### 3.5 Skill als Doc-mit-Resources

Konkrete Anwendung der 4 Bausteine auf Skills (das war Treiber):

**Datenmodell:**
- Skill-Manifest: `objects` Zeile mit `subtype='skill_manifest'`, body=`SKILL.md`-Markdown.
- Resource-Docs: separate `objects`-Zeilen mit `subtype='doc'`, body=resource-Inhalt.
- Verbindung: `object_refs(from=skill_id, to=resource_id, role='resource', meta={path: 'references/api.md'})`.

Der `meta.path` ist optional — falls der Skill-Autor die Anthropic-Pfad-Konvention nachbauen will. Default-Konvention für KC2: agent referenziert via ID/URI, nicht Pfad.

**Tool-Surface (Wrapper über `objects.*`):**

| Tool | Effekt |
|---|---|
| `skills.get(id)` | = `objects.read(id)` mit `subtype='skill_manifest'`-Check. Refs werden auto-mitgeliefert (3.2). Agent sieht die Resources sofort. |
| `skills.attach_resource(skill_id, doc_id)` | = `objects.add_ref(skill, doc, role='resource')` |
| `skills.detach_resource(skill_id, doc_id)` | = `objects.remove_ref(...)` |
| `skills.put(...)` | = `objects.create(subtype='skill_manifest', ...)` + optional `attach`-Liste in einem Call. |

**Anthropic-Pattern-Adaption — Hint-Convention im Body:** Skill-Autoren werden in der Konvention angehalten, im Body explizit auf Resources zu verweisen:

```markdown
# PDF-Handling

Skill für PDF-Operations.

## Resources

- **API-Reference** (kc://object/01J...) — pdfplumber + PyPDF2-API. Lies das wenn Du low-level operations brauchst.
- **Forms-Guide** (kc://object/01K...) — Schritt-für-Schritt Form-Fill. Lies das nur bei AcroForm-PDFs.
- **Examples** (kc://object/01L...) — Beispielcode für die häufigsten Patterns.
```

Damit hat der Agent **zwei** Signal-Kanäle:
1. Strukturiert in `refs.outgoing[]` mit `role='resource'` + `summary` (machine-readable)
2. Natürlich im Body mit „Wenn-Du-X-dann-lies-Y"-Hint (LLM-native)

Beide Kanäle parallel sind redundant aber robust — wenn der LLM einen Kanal übersieht, fängt der andere. Anthropic Skills nutzen nur Kanal 2; KC2 hat den Vorteil dass Storage strukturiert ist, also nutzen wir beide.

## 4. Konsumenten-Seite (mcp-approval2)

### 4.1 Adapter (`packages/adapters/src/knowledge/`)

- `KnowledgeObject` Type erweitern um `refs?: { outgoing: RefView[]; incoming: RefView[]; truncated: {...} }`.
- `RefView` Type: `{ role: string; id: string; subtype: string | null; title: string; summary: string | null; uri: string }`.
- `getObject({ id, expandBody, expandRefs?: boolean })` — `expandRefs=true` per default (sonst sieht User es nicht in der PWA, sonst sieht Agent es nicht).
- `searchObjects({ ... })` Hit-Type um `used_by[]` erweitern.

### 4.2 PWA — Storage-Detail-View ([apps/web/src/storage-detail.ts](apps/web/src/storage-detail.ts))

In der Info-Box (= bei Klick auf ℹ️) neue Sektion **„Verknüpfungen"**:

```
🔗 Verknüpfungen
   📎 Anhänge (resource → 2)
      • PDF-API-Reference [Öffnen]
      • PDF-Forms-Guide  [Öffnen]
   ↩ Verwendet von (part_of ← 1)
      • Office-Workflows-Skill-Pack  [Öffnen]
   ↗ Siehe auch (references → 1)
      • Invoice-PDF-Recipe  [Öffnen]
```

Click → router-navigate `#/storage/<uuid>`. Pro Ref ein „Lösen"-Button (kleiner X-Icon) für `objects.remove_ref` (write, geht durch Approval).

### 4.3 PWA — Search-Tab

Hits mit `used_by[]` zeigen einen kleinen „verwendet von: X"-Tag unter dem Title (analog v1).

### 4.4 Agent-Facing Tool-Descriptions

`objects.read`-Tool-Description in [knowledge2/src/mcp/register_tools.ts](https://github.com/axel-rogg/mcp-knowledge2/blob/main/src/mcp/register_tools.ts) erweitern um expliziten Hinweis:

> Returns the requested object **plus its outgoing and incoming knowledge-graph refs** (up to 5 each, with role + summary). Use the URIs in `refs.outgoing[].uri` to follow up with additional `objects.read` calls when the related content is relevant to your task. **Role `resource` means the linked object is part of this object** (e.g. a skill's reference docs) and is usually worth loading. Role `references` is optional/see-also.

Das ist die einzige Stelle wo der Agent „lernt" dass Refs existieren — die Tool-Description steht in jedem Tool-Call-Kontext.

## 5. Migration v1 → v2

Skills + Resources sind in v2 aus der v1-Migration übernommen, aber die `object_refs(role='skill_resource')`-Verbindungen fehlen. Konkret betroffen:

- 3 Skills (`agent-onboarding`, `mcp-help`, weitere) — alle haben in v1 Resources
- 5 Resource-Docs liegen als isolierte `subtype='doc'` in v2

**Migrations-Skript** `scripts/migrate-v1-refs.mjs`:
1. v1-MCP-Tool `docs.usages(skill_id)` für jeden migrierten Skill aufrufen → liefert v1-Ref-Liste
2. v1→v2 ID-Mapping über `meta.v1Id` (steht in v2-Objekten vom ersten Migration-Pass) auflösen
3. Pro Ref `objects.add_ref(role='resource', meta={v1Role: 'skill_resource'})` aufrufen
4. Idempotent (`onConflictDoNothing` ist im Storage schon drin)

Rollen-Mapping v1 → v2:
- v1 `skill_resource` → v2 `resource`
- alles andere v1 → v2 `references` (Soft-Fallback)

## 6. Anti-Patterns

Bewusst nicht gemacht:

- **Auto-Link-Detection im Body.** Keine NLP/LLM die im Body Inline-Begriffe automatisch zu Refs erhebt. Zu viel False-Positive-Schleppe, schwer zu invalidieren. Refs sind explizit angelegt.
- **Free-form Roles ohne Anti-Drift.** `role`-Spalte bleibt `text` für Forward-Compat, aber Tool-Surface validiert. Wenn ein Agent einen neuen Role-String erfindet ohne Operator-Approval landet er als unbekannte Rolle = `references`-Default.
- **Schema.org-Vollvokabular.** 30+ Predicates für 1 Solo-User mit ~100 Docs ist absurd. Wenn echte Use-Cases neue Rollen erzwingen (z.B. `derived_from` für Audit-Trail), kommt das einzeln in einem Follow-up-PLAN.
- **GraphRAG / HippoRAG.** Multi-hop-Reasoning über entity-extracted KG kostet $$ und ist bei <1000 Docs not worth it. Re-evaluation ab 10k Docs oder bei messbarem Multi-Hop-Failure-Rate.
- **Magic-Mode: Markdown-Links → object_refs sync.** Wer im Body `[Foo](kc://...)` schreibt, legt damit **kein** strukturiertes Ref an. Sync-Hell vermeiden. Wenn ein Ref strukturiert sein soll: `objects.add_ref` explizit aufrufen (oder via UI-Button).

## 7. Roll-Out-Plan (Phasen, jeweils klein)

| Phase | Scope | Aufwand | Repos |
|---|---|---|---|
| **0** | Konzept-Approval + Rollen-Vokabular finalisieren | — | docs only |
| **1** | KC2: `objects.read` extended response mit `refs`-Block; Tool-Description update; Cap=5 | ~ S | knowledge2 |
| **2** | Adapter: `KnowledgeObject.refs` + `RefView`-Type; ContractTest in `apps/server/tests/contract/` | ~ S | approval2 |
| **3** | KC2: `search`-Hits mit `used_by[]`-Annotation + 0.7×-Penalty für sub-docs | ~ M | knowledge2 |
| **4** | PWA: Storage-Detail-View „Verknüpfungen"-Sektion + Click-Navigate | ~ M | approval2 |
| **5** | Mandatory-Summary-Soft-Validation in `objects.create` + Warning in `add_ref` ohne Summary | ~ S | knowledge2 |
| **6** | v1→v2-Refs-Migration-Skript für die 5 Resource-Docs | ~ S | approval2 |
| **7** | `skills.attach_resource` / `detach_resource` / `skills.put`-with-attach Tool-Wrapper | ~ M | approval2 |
| **8** | `kc://`-URI-Resolver im PWA-Markdown-Renderer (`renderers/markdown.ts`) | ~ S | approval2 |
| **9** | `objects.read?include_bodies=resource` Eager-Mode | ~ S | knowledge2 + adapter |

Phasen 1+2+4 sind der Mindest-Useful-Slice (Agent sieht Refs, User sieht Refs). Phase 6 macht es **für die existierenden Skills** sichtbar. Rest ist Komfort + Skalierung.

## 8. Offene Fragen

1. **Cap=5 ist arbiträr.** v1 hatte 2 used_by + 5 outgoing/incoming. Reasonable, aber wenn ein Skill 12 Resources hat (large Skill-Pack) ist 5 zu wenig. Vorschlag: `objects.read?refs_limit=N` mit Default 5, Max 50.
2. **Reverse-Direction in Skill-Body-Hints.** Wenn Resource-Doc X von Skill Y referenziert wird — sollte die PWA dem User in X's Detail-View einen „🔗 Wird verwendet von Skill Y"-Hint zeigen? Das ist `incoming.role='resource'`. **Ja**, das ist schon in 4.2 abgedeckt — nur falls offene Frage entstehen sollte.
3. **Cycle-Detection (32-Hop) reicht für unsere Skala**, aber `depends_on` könnte tiefere Ketten erzeugen (Skill-A→B→C→D). Falls ein cycle entsteht: Storage wirft `errBadRequest`. Sollte der Agent das User-readable bekommen? Vermutlich ja — Wrapper-Error-Message anpassen.
4. **Service-Token-Scope.** `objects.add_ref` ist `sensitivity: write` → läuft durch Approval-Flow in approval2. Bei Migration-Skript: Service-Token-Path braucht ggf. einen `*_SYNC`-Token mit `approval_id`-Receipt. Pattern aus SEC-K-016 anwenden.
5. **`meta_json` pro Ref.** Aktuell ist `meta_json` für Refs nutzbar aber undokumentiert. Use-Cases: `{path: 'references/api.md'}` (Anthropic-Skill-Pfad), `{anchor: 'section-3'}` (Deep-Link), `{strength: 0.8}` (Auto-extracted-Refs falls Phase X). Soft-Schema in [PLAN-wrapper-conventions.md](PLAN-wrapper-conventions.md) ergänzen wenn Phase 5+ kommt.

## 9. Implementation-Plan (Phase-by-Phase, File-Level)

Touch-Liste pro Phase. Dependencies: jede Phase darf nur Vorgänger voraussetzen. Tests in derselben Phase angelegt wie der Code (kein „test-debt"-Bucket).

Naming: KC2-Files relativ zu `/workspaces/mcp-knowledge2/`, A2-Files relativ zu `/workspaces/mcp-approval2/`.

### Phase 1 — KC2: `objects.read` returns refs

**Ziel:** Agent sieht Refs bei jedem `objects.read`-Call, ohne separaten `usages`-Call.

| Datei | Änderung |
|---|---|
| `src/storage/refs.ts` | **+** `listRefsForObject(id, limit=5)` returns `{outgoing: RefView[], incoming: RefView[], truncated: {outgoing, incoming}}`. **JOIN** `object_refs` mit `objects` für `title`/`description (= summary)`/`subtype` der Target/Source-Objekte. Pro Direction `ORDER BY created_at DESC LIMIT (limit+1)` — wenn n+1 Rows zurück, `truncated.X = totalCount - limit` (separate COUNT-Query). |
| `src/storage/objects.ts` | `readObject({ id, includeRefs?: boolean, refsLimit?: number })`. Default `includeRefs=true`. Im Response: zusätzlich `refs?: {outgoing, incoming, truncated}` Feld. |
| `src/routes/objects.ts` | `GET /v1/objects/:id?refs_limit=N` — parsed Query-Param, durchreicht. |
| `src/mcp/register_tools.ts` | `objects.read`-Tool: Input-Schema `+refs_limit?: number max(50)`, Handler reicht durch. **Tool-Description erweitern** (siehe §4.4 — exakter Text dort). |
| `src/types/domain.ts` (oder lib equivalent) | `+ interface RefView { role: string; id: string; subtype: string \| null; title: string \| null; summary: string \| null; uri: string }`. URI-String wird in der Storage-Layer gebildet: `kc://object/${id}`. |
| `tests/storage-refs-on-read.test.ts` (neu) | (1) read with no refs → empty arrays. (2) read with 3 outgoing → all returned, truncated=0. (3) read with 7 outgoing, limit=5 → 5 returned, truncated=2. (4) read with cycle (A→B, B→A) — both endpoints show the rev directions correctly. (5) RLS: refs to objects in another user's namespace are not exposed. |

**Cap-Default = 5** wie in §3.2 begründet. **Hardcap = 50** wegen Token-Budget — `refsLimit > 50` → `errBadRequest`.

**Performance-Note:** `listRefsForObject` macht 4 Queries: outgoing-list + incoming-list + outgoing-count + incoming-count. Bei p95 von ~150 Refs pro Object: alle 4 Queries unter 5 ms zusammen (Index `idx_refs_to` existiert; `from_id` ist Teil des PK = auch indexiert). Wenn Count zum Bottleneck wird: optional auf `LIMIT n+1`-Trick wechseln (kein exakter `truncated`-Count, nur „mehr da", boolean).

### Phase 2 — Adapter Contract

**Ziel:** approval2's Adapter spiegelt das neue KC2-Format wire-format-stabil.

| Datei | Änderung |
|---|---|
| `packages/adapters/src/knowledge/types.ts` | **+** `RefView` (Mirror der KC2-Definition). **+** Optional-Property `readonly refs?: KnowledgeObjectRefs` auf `KnowledgeObject`. **+** `interface KnowledgeObjectRefs { outgoing: readonly RefView[]; incoming: readonly RefView[]; truncated: { outgoing: number; incoming: number } }`. |
| `packages/adapters/src/knowledge/http-client.ts` | `normaliseObjectView` pass-through `refs` (kein Reshape nötig, identisches Format). `getObject(args)` akzeptiert optional `refsLimit?: number`, hängt `&refs_limit=N` an. |
| `apps/server/src/routes/knowledge-proxy.ts` | Query-Param `refs_limit` durchreichen (analog zum existierenden `expand`-Pattern). |
| `apps/server/tests/contract/objects-refs.test.ts` (neu) | (1) Mock-KC2-Response mit `refs` → Adapter normalisiert ohne Verlust. (2) `getObject` mit `refsLimit=3` sendet korrekten URL-Param. (3) Schema-Drift-Wächter: snapshot der erwarteten KC2-Response-Shape. |

### Phase 3 — KC2: `search` mit `used_by[]`

**Ziel:** Search-Hits zeigen "wer mich referenziert", damit Agent Kontext rekonstruieren kann.

| Datei | Änderung |
|---|---|
| `src/storage/refs.ts` | **+** `listIncomingForBatch(ids: string[], limit=2)` returns `Map<id, RefView[]>`. Eine SQL: `SELECT ... FROM object_refs JOIN objects ON to_id IN (...) ORDER BY to_id, created_at DESC` mit Client-side Gruppierung. **+** `listIncomingResourceFor(ids)` returns `Set<id>` der Objekte die als `resource` ref-target sind (für Penalty). |
| `src/search/hybrid.ts` | Nach RRF-Ranking & vor Response: (1) Top-K Hit-IDs sammeln. (2) `listIncomingForBatch(topIds, limit=2)`. (3) Jedem Hit `used_by: RefView[]` + `used_by_truncated: number` anhängen. (4) **Penalty-Pass:** für Hits in `listIncomingResourceFor`: `score *= 0.7`, dann **re-rank**. Reihenfolge kann sich verschieben — das ist Absicht (Top-Level-Docs vorne). |
| `tests/search-used-by.test.ts` (neu) | (1) Hit ohne incoming → `used_by=[]`. (2) Hit mit 4 incoming, limit=2 → 2 zurück, truncated=2. (3) Penalty: Hit A (Skill, kein incoming) vs B (Resource-Doc, incoming.role=resource) — A muss vorne sein nach Penalty obwohl B höheren RRF-Score hatte. (4) Penalty wirkt **nicht** bei `role=references` — nur `resource`. |

**Subtilität:** Die Penalty soll *nicht* angewandt werden wenn der Query explizit auf sub-docs zielt (z.B. `subtype=doc` Filter). Aktuell ohne Sonder-Logik — User-Feedback abwarten. Annahme: in 90 % der Fälle sucht User "thematisch" und will Manifeste vor Resources.

### Phase 4 — PWA: Storage-Detail "Verknüpfungen"-Sektion

**Ziel:** User sieht Refs visuell + kann zu verlinkten Objekten navigieren.

| Datei | Änderung |
|---|---|
| `apps/web/src/storage-detail.ts` | Neue Funktion `renderRefsSection(obj: KnowledgeObject): HTMLElement \| null`. Returns `null` wenn beide Listen leer. In `renderInfoBox()` (oder gleichwertig — der bestehende Info-Box-Renderer) zwischen Meta-Properties und Tags einfügen. Gruppierung nach Rolle (DE-Labels: §3.1). Pro Eintrag: Click-Handler → `location.hash = '#/storage/${id}'`. **Summary stripIpiWrappers**, dann ersten Satz oder bis 200 Chars rendern. |
| `apps/web/src/styles.css` | **+** `.refs-section` + `.refs-group` + `.ref-row` + `.ref-role-badge`. Existing earthy palette (`--accent` für aktive Hover, `--muted` für sekundär). |
| `apps/web/src/api.ts` | Kein Change — `KnowledgeObject` aus Adapter trägt `refs` schon. |
| `apps/web/tests/storage-detail-refs.test.ts` (neu, **wenn** in v2 ein Web-Test-Setup existiert — vitest workspace `web`) | (1) Object mit 0 refs → keine Sektion. (2) Object mit outgoing+incoming → beide Gruppen sichtbar. (3) Click → hash-change ohne Page-Reload. (4) `external-content`-wrapped summary → tags entfernt. |

**Ausgeklammert für später:** "Lösen"-Button pro Ref. Bringt Approval-Flow-Plumbing rein (sensitivity=write), das ist Phase 7+ Material. Refs lösen geht aktuell nur via Agent (`objects.remove_ref`).

### Phase 5 — Soft-Validation Mandatory-Summary

**Ziel:** Refs zu Objekten ohne Summary werden flagged, nicht hart geblockt.

| Datei | Änderung |
|---|---|
| `src/storage/refs.ts` | `addRef` returns `{warnings: string[]}` (statt void). Wenn `to_id`-Object kein `description` (oder leer) hat: `warnings.push("target object has no summary — agent will load defensively")`. Backward-compatible — Callers die return ignorieren laufen weiter. |
| `src/mcp/register_tools.ts` | `objects.add_ref`-Handler propagiert `warnings` in den Response: `jsonResult({ ok: true, warnings })`. |
| `src/storage/objects.ts` | **Optional:** `createObject` mit `subtype ∈ ['skill_manifest', 'doc', 'recipe']` ohne `description` → `warnings: ["no summary — won't show usefully in refs"]`. Bewusst soft — alte Migrations-Daten existieren. |
| `tests/storage-refs-warnings.test.ts` (neu) | (1) `addRef` zu Object mit Summary → keine Warning. (2) Ref zu Object ohne Summary → `warnings.length === 1`. (3) `addRef` läuft trotzdem durch (kein Throw). |

### Phase 6 — Migration v1 → v2 Refs

**Ziel:** Die 5 isolierten Resource-Docs werden wieder mit ihren Skills verbunden.

| Datei | Änderung |
|---|---|
| `scripts/migrate-v1-refs.mjs` (neu, approval2) | (1) Liste der migrierten v1-Skill-IDs lesen (aus `meta.v1Id` aller v2-Objekte mit `subtype='skill_manifest'`). (2) Pro v1-Skill: v1-MCP-Tool `docs.usages(v1_skill_id)` aufrufen (via existierendes `tools_run`-Wrapper-Pattern aus `migrate-v1-all.mjs`). (3) v1-Output liefert `outgoing` Refs mit v1-Target-IDs. (4) v1→v2 ID-Map aus `meta.v1Id` aller v2-Docs aufbauen. (5) Pro Ref: `objects.add_ref(from=v2_skill_id, to=v2_doc_id, role='resource')` via approval2-internal-Endpoint (analog `migrate-v1-apps.mjs`-Pattern mit synthetischem `approval_id`). (6) **Idempotent:** Storage-Layer hat `onConflictDoNothing`, plus Skript zählt added/skipped. |
| Logging | Klare Output-Sektion mit `[added 7 refs] [skipped 2 already-present] [skipped 0 v1-id-not-found]` am Ende. |
| **Pre-Flight-Check** | Skript startet mit `--dry-run` als Default. Echte Schreibe nur mit `--apply`. |
| Tests | Manueller Walk-Through (kein E2E-Test sinnvoll — Live-MCP-Call gegen v1-Production). |

### Phase 7 — `skills.*` Tool-Wrapper

**Ziel:** Skill-Autoren (Agent + User) bekommen ergonomische Tools statt `objects.add_ref(role='resource')`.

| Datei | Änderung |
|---|---|
| `apps/server/src/tools/skills/attach-resource.ts` (neu) | Wrapper-Tool `skills.attach_resource(skill_id, doc_id, path?)` → `objects.add_ref(role='resource', meta={path})`. WYSIWYS-display: "Attach doc {{doc_id}} as resource to skill {{skill_id}}". Sensitivity=write. |
| `apps/server/src/tools/skills/detach-resource.ts` (neu) | Analog `objects.remove_ref(role='resource')`. |
| `apps/server/src/tools/skills/put.ts` (neu — **erst wenn** ein klares User-Need da ist; ggf. Phase 7b) | Bundled `skills.put(manifest, attach: [{doc_id, path?}, ...])` — **1 Approval** für Skill+alle Resources statt N Approvals. Implementation: erst `objects.create` (oder `update` falls update_id übergeben), dann mehrere `objects.add_ref` in einer Service-Transaction. |
| Tests | Tool-Registry-Test (Wrapper sind registriert), Snapshot-Test der WYSIWYS-Templates. |

**Trade-Off:** `skills.put` ist mehr Code als Wert solange Skills sehr manuell editiert werden. Phase 7b erst wenn Phase 6 zeigt dass Skills oft mit Resources zusammen mutiert werden.

### Phase 8 — `kc://` URI-Resolver im PWA-Markdown

**Ziel:** Inline-`[Foo](kc://object/...)` im Body werden zu klickbaren Storage-Links.

| Datei | Änderung |
|---|---|
| `apps/web/src/renderers/markdown.ts` | Nach `marked.parse()` + `DOMPurify.sanitize()`: TreeWalker über alle `<a>`-Elemente. Wenn `href.startsWith('kc://object/')`: extract `<uuid>`, rewrite `href = '#/storage/' + uuid`, optional `title` + Icon-Prefix. DOMPurify-Allowlist muss `href` mit hash erlauben (sollte default sein). |
| `apps/web/tests/markdown-kc-uri.test.ts` (neu, falls Setup existiert) | `[Foo](kc://object/abc-123)` → `<a href="#/storage/abc-123">`. Garbage-URI (`kc://`, `kc://object/`, `kc://other/x`) → kein rewrite, raw href bleibt — DOMPurify nimmt es dann eh raus wenn kein erlaubtes Schema. |

**Defensive Anmerkung:** DOMPurify allowed-protocols-Liste prüfen. `kc:` ist **nicht** in der default-Allowlist von DOMPurify — Marked wird's drinnen lassen, DOMPurify wird's strippen oder leeren. Lösung: Rewrite **vor** DOMPurify (zwischen marked und Purify), nicht danach. **Korrektur:** Rewrite vor DOMPurify.

### Phase 9 — Eager-Embed-Mode `?include_bodies=resource`

**Ziel:** Agent kann mit einem Call ein komplettes Skill-Bundle (Manifest + alle Resources inline) ziehen.

| Datei | Änderung |
|---|---|
| `src/storage/objects.ts` | `readObject({ includeRefBodies?: string[] })` — Array von Rollen die in `refs.outgoing[].body` eingebettet werden. Pro Ref-Object: Body-Fetch (D1/R2 same as Primary-Read). Token-Budget-Schutz: **summed body-bytes cap** (z.B. 200 KB) — bei Überschreitung partial-load mit `truncated_at_byte_budget=true`-Flag. |
| `src/routes/objects.ts` | Query-Param `include_bodies=resource,references` (CSV). |
| `src/mcp/register_tools.ts` | Tool-Schema erweitern. **Description erwähnt Token-Budget**: "Use sparingly — fetches up to 200 KB of related-doc bodies in one call." |
| `packages/adapters/src/knowledge/http-client.ts` | `getObject({ includeRefBodies?: readonly string[] })` durchreichen als URL-Param. |
| Tests | Body-Budget-Cap-Verhalten. |

**Trade-off:** Phase 9 ist eine **Komfort-Optimierung**, nicht load-bearing. Phase 1 (Refs sichtbar) reicht für 90 % der Use-Cases — Agent macht 2-3 Round-Trips statt 1. Verschieben bis Phase 7 fertig ist und ein konkreter Skill-Bundle-Pattern entsteht.

### Phasen-Dependency-Graph

```
P1 (KC2 read+refs) ──┬─→ P2 (Adapter) ──→ P4 (PWA)
                     │                       
                     ├─→ P3 (search used_by)  
                     │                       
                     ├─→ P5 (warnings) ──→ P6 (v1-migration) ──→ P7 (skills.*)
                     │                                                      │
                     └────────────────────────────────────────────────────→ P9 (eager-embed)
                     
P8 (kc:// resolver) — unabhängig, kann parallel zu allem
```

**Minimum-Useful-Slice (MUS):** P1 + P2 + P4 = Agent + User sehen Refs. ~ S+S+M Aufwand. Danach Stop-und-Review.

### Test-Strategie pro Phase

- **Unit-Tests** an der Datei wo der Code lebt (vitest workspace).
- **Contract-Tests** in `apps/server/tests/contract/` für jeden adapter↔KC2-Wire-Format-Punkt (P2 zwingend, P3 sollte).
- **PWA-Visual-Tests:** Keine — manuell via `npm run dev` + Browser. Storage-Detail-View hat schon im aktuellen Code keine Visual-Regression-Tests, da nicht im Bestand.
- **Smoke-Test-Update:** `scripts/pilot-smoke.sh` (oder Pendant) bekommt einen End-to-End-Test in P4: "create skill+doc+attach → read skill → assert refs.outgoing.length === 1".

### Roll-Back-Plan

- **P1:** Tool-Description in `register_tools.ts` revert + `includeRefs=false`-Default. Daten in `object_refs` bleiben — keine destruktive Op.
- **P2:** Adapter-Type-Property ist optional — alter Code läuft.
- **P3:** Search-Penalty als ENV-Flag `SEARCH_SUBDOC_PENALTY=on/off` (Default `on`) — Rollback per Doppler-Toggle ohne Deploy.
- **P4:** PWA-CSS-Hide-Class als Notfall (`.refs-section { display: none }`).
- **P6 (Migration):** `objects.remove_ref` für jedes added Ref. Skript hat Output-Logging mit allen IDs → reversible.

### Aufwands-Schätzung (Person-Tage Solo)

| Phase | Coding | Tests | Review-Risiko | Σ |
|---|---|---|---|---|
| P1 | 0.5 | 0.5 | mid | 1 |
| P2 | 0.25 | 0.25 | low | 0.5 |
| P3 | 0.75 | 0.5 | high (Penalty-Heuristik) | 1.5 |
| P4 | 0.5 | 0.25 | low | 0.75 |
| P5 | 0.25 | 0.25 | low | 0.5 |
| P6 | 0.5 | — (manuell) | mid | 0.5 |
| P7 | 0.5 | 0.25 | mid | 0.75 |
| P8 | 0.25 | 0.25 | low | 0.5 |
| P9 | 0.75 | 0.5 | mid (Budget-Cap) | 1.25 |

**MUS (P1+P2+P4): ~ 2.25 PT.** Full-Plan: ~ 7 PT.

## 10. Review-Outcomes (Subagent-Pass 2026-05-17)

Drei parallele Reviews (MCP-Spec / DB-Backend / Frontend-IPI). Folgende **6 🔴-Findings sind Plan-Korrekturen** (von User-Decisions abgesehen). Original-Sections oben sind **noch nicht** redigiert — siehe diese §10 als Override-Liste, oder rebuild §1-9 nach User-Sign-Off.

### 🔴 R1 — MCP-Spec-Compliance: `resource_link`-Content-Blocks zusätzlich

Override für §3.2: `objects.read` emittiert **beides**:

```json
{
  "content": [
    { "type": "text",          "text": "<JSON-Body...>" },
    { "type": "resource_link", "uri": "kc://object/01J...", "name": "PDF-API-Reference",
      "description": "...", "mimeType": "text/markdown",
      "_meta": { "role": "resource", "subtype": "doc" } }
  ],
  "structuredContent": { "result": {...}, "refs": { "outgoing": [...], "incoming": [...] } }
}
```

Begründung: Claude Desktop / claude.ai parsen `resource_link` nativ als Preview-Karten. Agent-SDK-Clients sehen typed content. `structuredContent.refs[]` bleibt für Contract-Tests + Adapter-Mapping.

**Touch zusätzlich:** `src/mcp/register_tools.ts` `jsonResult()`-Helper erweitern um optional `resource_link[]` Konstruktor.

### 🔴 R2 — RLS-Leak: `refs_via_object` prüft nur `from_id`

Override für P1-Test-(5): Tech-Debt-Note in §8 reicht **nicht**. Vor Share-Feature in `0001_rls.sql` oder neuer Migration:

```sql
DROP POLICY refs_via_object ON object_refs;
CREATE POLICY refs_via_object ON object_refs USING (
  EXISTS (SELECT 1 FROM objects WHERE objects.id = object_refs.from_id)
  AND EXISTS (SELECT 1 FROM objects WHERE objects.id = object_refs.to_id)
);
```

Plus: JOIN auf `objects` in `listRefsForObject` als **INNER JOIN** (versteckt unsichtbare Targets statt NULL-Rows). Aktuell pre-Share kein User-facing Bug, aber load-bearing wenn Share kommt — fix **jetzt**, nicht später.

### 🔴 R3 — Hot-Path: `objects.is_subdoc boolean` Cached-Column statt JOIN+RLS

Override für §3.2 Penalty + P3:

```sql
ALTER TABLE objects ADD COLUMN is_subdoc boolean NOT NULL DEFAULT false;
CREATE INDEX idx_objects_is_subdoc ON objects(is_subdoc) WHERE is_subdoc = true;
```

- `addRef(role='resource')` setzt `is_subdoc=true` auf `to_id` (analog refcount).
- `removeRef` setzt zurück wenn **letztes** resource-Ref entfernt wird (`refcount`-Pattern reicht nicht direkt — eigene Resource-Count-Logik nötig, ggf. zweite cached column `resource_refcount`).
- Penalty in `search/hybrid.ts` wird Column-Read im Hit (kein Extra-Query, schon im SELECT enthalten).
- Bei 50 Hits spart das ~100 RLS-Subquery-Evals — messbar in p95.

Plus: `used_by[]`-Batch via LATERAL JOIN (eine Query statt N+1):

```sql
SELECT t.id AS to_id, r.from_id, r.role, o2.title, o2.description
FROM unnest($1::uuid[]) AS t(id)
CROSS JOIN LATERAL (
  SELECT * FROM object_refs WHERE to_id = t.id ORDER BY created_at DESC LIMIT 3
) r
JOIN objects o2 ON o2.id = r.from_id;
```

### 🔴 R4 — Refs FK-Cascade fehlt

Schema-Migration (in P1 vorziehen):

```sql
ALTER TABLE object_refs
  ADD CONSTRAINT object_refs_from_fk FOREIGN KEY (from_id) REFERENCES objects(id) ON DELETE CASCADE,
  ADD CONSTRAINT object_refs_to_fk   FOREIGN KEY (to_id)   REFERENCES objects(id) ON DELETE CASCADE;
```

Bei `softDeleteObject`: kein Cascade, weil Soft. Mitigation: `listRefsForObject` JOINed `WHERE o.deleted_at IS NULL` (versteckt Refs auf gelöschte Targets). Refcount-Drift bei Soft-Delete bleibt — akzeptabel weil kosmetisch.

### 🔴 R5 — IPI: Ref-Summaries müssen server-seitig gewrappt werden

**Plan-Blocker.** Override für §3.4 + §4.1: bevor `refs.outgoing[].summary` in MCP-Response landet, muss approval2's Tool-Output-Layer User-Content wrappen. v2 hat **kein** `<external-content>`-Wrapping geportet — search `external-content` im Server-Code liefert 0 Hits.

**Lösung:**
- Neuer Wrapper-Layer in `apps/server/src/mcp/output-filter.ts` (neu) — wrappt `title`, `description`, `summary`, `body` aller `KnowledgeObject`-Returns (inkl. `refs.outgoing[].summary`) in `<external-content source="kc:objects.read" untrusted="true">...</external-content>` **bevor** sie in den MCP `content`-Block serialisiert werden.
- PWA stripped weiter via `stripIpiWrappers` (Status quo).
- `structuredContent.refs.outgoing[].summary` **gleichermaßen** wrappen — Claude liest beide Kanäle.

**Phase-1-Sequenz erweitern:** P1a (IPI-Wrapper-Layer als Vorarbeit) **vor** P1b (refs in objects.read response). Sonst ist Phase 1 ein IPI-Verstärker statt Knowledge-Graph.

### 🔴 R6 — `kc://`-Resolver: Whitelist + DOMPurify-Config statt naiver Rewrite

Override für §3.3 + P8:

1. **DOMPurify-Config** in `apps/web/src/renderers/markdown.ts`: `ALLOWED_URI_REGEXP: /^(?:(?:https?|kc):)/i` plus `ADD_DATA_URI_TAGS: []`. Damit überlebt `href="kc://object/<uuid>"` die Sanitize-Phase, alle anderen Schemes werden gestripped.
2. **Strikter Tree-Walker post-Purify** (nicht pre): walk nur `<a>` mit `href.match(/^kc:\/\/object\/[0-9a-f-]{36}(?:#[a-zA-Z0-9_-]+)?$/i)`. Match → rewrite zu `#/storage/<uuid>`. No match → unverändert lassen.
3. **Negative Tests** in `apps/web/tests/markdown-kc-uri.test.ts`: `[a](javascript:alert(1))` → DOMPurify strippt. `[a](kc://object/garbage)` → kein Rewrite, DOMPurify lässt's stehen (Display-only — kein klickbarer Storage-Link).

---

### ⚠️-Findings (Plan-Verbesserungen, keine Blocker)

| # | Finding | Action |
|---|---|---|
| R7 | `part_of` als separate Rolle redundant — Inverse aus `incoming.role='resource'` ableiten | §3.1: Vokabular auf **3 Rollen** kürzen (`resource`/`references`/`depends_on`). UI-Label „Teil von" bleibt — kommt aus `incoming`-Direction. |
| R8 | Group-by-Parent statt 0.7×-Penalty in Search | Phase 3 als Experiment markieren. Default `SEARCH_SUBDOC_PENALTY=on` (heuristik), Group-by-Parent als follow-up wenn Penalty Schwächen zeigt. |
| R9 | `truncated: number` → `truncated: boolean` (LIMIT n+1 Trick) | §3.2 Response-Shape anpassen. Spart 2 COUNT-Queries pro `read`. |
| R10 | Tool-Description straffen + `objects.usages` deprecaten (redundant nach P1) | P1: Description konkreter (Reviewer-1 Vorschlag-Text übernehmen). `objects.usages` aus `tools/list` entfernen nach P1+P2 deployed. |
| R11 | `idx_refs_role` löschen (unused) | Neue Migration. Cleanup, kein Functional-Change. |
| R12 | P6 (v1-Migration) **vor** P4 (PWA-Storage-Detail) schedulen | User sieht direkt gefüllte „Verknüpfungen", nicht „leeres Feature". Phasen-Dependency-Graph in §9 updaten. |
| R13 | Speaking `approval_id` für Migrations-Audit-Trail | `scripts/migrate-v1-refs.mjs`: `approval_id = 'migration-v1-refs-<isoDate>'`-Format statt random-UUID. |
| R14 | Consumer-Audit für `KnowledgeObject.refs?`-Property | Phase 2 explizit listen: `apps/server/src/apps/api.ts`, `kc_wrappers/*`, `services/knowledge.ts` — checken dass kein `Object.keys`/`for-in`-Iterator das neue Feld als Meta-Row rendert. |
| R15 | `skills.get_bundle(id)` als symmetrische Eager-Read-Surface zu `skills.put(attach)` | Phase 9 ergänzt um Bundle-Tool. Implicit `include_bodies=resource`-Setting für `skills.get_bundle`. |
| R16 | `skills.put(attach)` Bulk-Cycle-Detection mit gesharedem Visitor-Cache | Phase 7 Sub-Bullet. Pre-Scan einmal über alle attach-Targets statt N einzelne BFS-Walks. |
| R17 | `include_bodies=resource` Token-Budget via `body_size`-Sum vor Decrypt | Phase 9: greedy-Sort nach `created_at` + cumulative `body_size`-Sum, dann nur die zugelassenen IDs decrypten. Spart R2-Fetches. |
| R18 | Adapter-Contract-Test als Snapshot der Wire-Shape (nicht RLS-Test) | Phase 2: `objects-refs.test.ts` als Snapshot-Test (KC2-Response-Shape fixiert). RLS bleibt KC2-seitig getestet. |

## 10.5 Decision-Lock 2026-05-17

User-Antworten auf §10 Open-Decisions. Dies ist die kanonische Entscheidung. §3.1/§3.2/§3.4/§9 sind im Lichte dieser Locks neu zu lesen — folgender Block ist die Override-Quelle, die §1-9 redigiert.

### D1 (R1) ✅ — `resource_link` emittieren

`objects.read`-MCP-Response trägt **beides**: `content[]` mit `text` + `resource_link[]`, und `structuredContent.refs`. Siehe §10 R1 für den genauen Shape.

### D2 (R3) ✅ — `is_subdoc` Cached-Column einführen — mit M:N-Korrektsemantik

**User-Caveat:** „mehrere Dokumente können auf eines zeigen und umgekehrt." Das M:N-Modell ist im Schema bereits drin (`object_refs` ist eine Junction-Table mit PK auf `(from_id, to_id, role)` — viele→viele nativ). Der `is_subdoc`-Toggle muss diese M:N-Realität spiegeln. Konkrete Semantik:

| Event | Pre-State | Post-State | Action |
|---|---|---|---|
| `addRef(role='resource', to=X)` (1. resource-ref auf X) | X.is_subdoc=false | X.is_subdoc=true | UPDATE |
| `addRef(role='resource', to=X)` (n+1-te resource-ref auf X) | X.is_subdoc=true | X.is_subdoc=true | NO-OP idempotent |
| `removeRef(role='resource', to=X)` (es bleiben noch resource-refs auf X) | X.is_subdoc=true | X.is_subdoc=true | NO-OP — `is_subdoc` bleibt true solange **mindestens ein** `role='resource'`-Ref auf X zeigt |
| `removeRef(role='resource', to=X)` (letzter resource-ref entfernt) | X.is_subdoc=true | X.is_subdoc=false | UPDATE — bedingt durch EXISTS-Check |

Implementation in [`/workspaces/mcp-knowledge2/src/storage/refs.ts`]:

```typescript
// in addRef (nach erfolgreichem INSERT):
if (input.role === 'resource' && inserted.length > 0) {
  await db.update(objects).set({ isSubdoc: true }).where(eq(objects.id, input.toId));
  // idempotent — setze auf true, egal ob es vorher schon true war
}

// in removeRef (nach erfolgreichem DELETE):
if (role === 'resource' && deleted.length > 0) {
  const stillAny = await db.select({ x: sql`1` })
    .from(objectRefs)
    .where(and(eq(objectRefs.toId, toId), eq(objectRefs.role, 'resource')))
    .limit(1);
  if (stillAny.length === 0) {
    await db.update(objects).set({ isSubdoc: false }).where(eq(objects.id, toId));
  }
}
```

Die EXISTS-Check ist **eine** indexed-Lookup-Query (`idx_refs_to` + role-Filter, oder neu `idx_refs_to_role(to_id, role)` falls nötig). M:N-sicher: wenn Doc-X gleichzeitig Resource von Skill-A + Skill-B + Skill-C ist und Skill-A wird gelöscht (Cascade entfernt Ref A→X), bleiben B+C-Refs — `is_subdoc` bleibt korrekt true.

Plus: gleiches Pattern wahrscheinlich auch bei `outgoing`-Direction nicht nötig — `is_subdoc` ist eine reine `to_id`-Eigenschaft (wer wird referenziert), unabhängig davon was X selbst referenziert.

### D3 (R5) ✅ — IPI-Wrapper-Layer in **diesem** PLAN

Phase **1a** (IPI-Wrapper) vor Phase 1 (refs in objects.read). Neue Komponente `apps/server/src/mcp/output-filter.ts`:

- Wrapped vor MCP-Serialisierung **alle** User-Content-Felder eines `KnowledgeObject`-Returns: `title`, `description`, `body` (wenn text), plus pro Ref in `refs.outgoing[]`/`refs.incoming[]`: `title`, `summary`. Plus pro `used_by[]`-Eintrag in Search-Hits (kommt in P3).
- Wrap-Form: `<external-content source="kc:objects.read" untrusted="true">{value}</external-content>` (v1-Pattern aus mcp-approval — kompatibel mit PWA's `stripIpiWrappers`).
- Wrap geschieht **server-side** zwischen Tool-Execution und MCP-Response-Block. Adapter sieht raw Werte (Wire-Format-Stabilität); LLM sieht gewrappte Werte.
- Konfigurierbar via ENV `IPI_WRAP_KC_RETURNS=on` (default on). Off-Mode für Debug-Zwecke.

Touch-Liste Phase 1a:
- **+** `apps/server/src/mcp/output-filter.ts` — neue Funktion `wrapKcUntrusted(obj)` mit recursivem Walk über bekannte User-Content-Felder.
- `apps/server/src/tools/objects-tools.ts` (und alle anderen Tool-Wrapper die `KnowledgeObject` zurückgeben — `docs-tools.ts`, `skills-tools.ts`, etc.) — pre-return Hook: `return wrapKcUntrusted(obj)`.
- `apps/server/tests/output-filter.test.ts` — unit-Tests: wrapped each known field, idempotent (kein Doppel-Wrap wenn schon gewrappt), passes non-User-Content (`id`, `version`, `created_at`) durch.
- PWA: keine Änderung. `stripIpiWrappers` in `storage-detail.ts` ist schon drin und arbeitet identisches Format weg.

### D4 (R7) ✅ — 3 Rollen (`resource` / `references` / `depends_on`)

`part_of` wird **nicht** als separate Rolle gespeichert. Inverse wird in der Response-Layer aus `incoming.role='resource'` abgeleitet:

| Direction | DB-Role | UI-Label DE | Wer lädt mit? |
|---|---|---|---|
| outgoing | `resource` | „Anhang" | Agent: ja, eager |
| outgoing | `references` | „Siehe auch" | Agent: lazy |
| outgoing | `depends_on` | „Benötigt" | Agent: ja, wenn ausgeführt |
| **incoming** | `resource` | **„Teil von"** (= part_of, derived) | nicht eager |
| incoming | `references` | „Referenziert von" | nicht eager |
| incoming | `depends_on` | „Wird benutzt von" | nicht eager |

Damit ist `part_of` nicht verloren, sondern direction-derived. Compound-Doc-Use-Case (Chapter-of-Book): Buch ist Parent mit `outgoing.role='resource'`-Refs zu jedem Chapter; Chapter sieht Buch via `incoming.role='resource'` = UI-Label „Teil von" = semantisch korrekt.

### D5 (R8) ✅ — Direkt Group-by-Parent in Search

Phase 3 wird umgebaut: keine 0.7×-Penalty mehr, sondern hierarchische Hit-Groups. Spec:

**Search-Pipeline post-RRF (in `/workspaces/mcp-knowledge2/src/search/hybrid.ts`):**

1. Top-K Hit-Set bauen (z.B. K=20 pre-group → ~10 post-group).
2. Für jeden Hit: prüfen ob er `is_subdoc=true` ist (cached column aus D2 — kein Extra-Query).
3. Für jeden Sub-Doc-Hit: lookup Parent-IDs via `outgoing.role='resource'` der incoming-Refs — wer hat mich als Resource? (Eine batched Query: `SELECT to_id, from_id FROM object_refs WHERE to_id IN (subdoc_ids) AND role='resource'`.)
4. Drei Fälle pro Sub-Doc-Hit:
   - **Parent auch in Hit-Set:** Sub-Doc als `child_hit` an Parent attachen, aus Top-Level entfernen. Parent kriegt höchsten der gruppierten Scores.
   - **Parent NICHT in Hit-Set:** Sub-Doc bleibt Top-Level, aber kriegt `linked_parent: {id, title, summary, uri}` Field für Navigation. **Kein Suppress** — User suchte nach „form filling", Resource „PDF-Forms-Guide" matched, Parent „PDF-Skill" did not — Resource ist die richtige Antwort, mit Pfad zurück.
   - **Mehrere Parents:** Sub-Doc-Hit wandert unter den Parent mit höchstem Hit-Score; weitere Parents als `also_linked_parents[]` (cap 2).
5. Result-Shape:

```json
{
  "hits": [
    { "id": "01H...", "title": "PDF-Handling", "summary": "...", "score": 0.87, "uri": "kc://...",
      "child_hits": [
        { "id": "01J...", "title": "PDF-Forms-Guide", "summary": "...", "score": 0.74, "uri": "kc://..." }
      ]
    },
    { "id": "01K...", "title": "Recipe X (orphan resource)", "score": 0.62,
      "linked_parent": { "id": "01L...", "title": "Some Skill", "uri": "kc://..." }
    }
  ]
}
```

Trade-off vs Penalty: ~50 LOC mehr in `hybrid.ts`, 1 extra DB-Query pro Search (batched). Vorteil: token-effizienter (Parent + 1 Snippet statt 4 entkoppelte Hits), resilient gegen RRF-Score-Distributions. `used_by[]` wird obsolet als separates Feld — die Info ist in `child_hits` und `linked_parent` reicher modelliert.

**ENV-Flag** `SEARCH_GROUP_MODE=group|flat|penalty` (default `group`). `flat` schaltet das Grouping aus (top-K wie RRF kommt), `penalty` als Fallback wenn Group-Logic Bugs zeigt — ein-Deploy-Rollback.

### Decision-Impact auf §9 Phasen-Reihenfolge

```
P1a (IPI-Wrap-Layer)                    [NEU, blocks alles]
   ↓
P1  (KC2 read+refs, mit resource_link + 3-Rollen + is_subdoc-Toggle)
   ↓
P2  (Adapter Contract, RefView mit Wire-Snapshot-Test)
   ↓
P6  (v1→v2 Refs-Migration — vorgezogen vor P4 nach R12)
   ↓
P4  (PWA Storage-Detail Verknüpfungen-Sektion)
   ↓
P3  (KC2 Search Group-by-Parent — neues Group-Modell aus D5)
   ↓
P5  (Soft-Validation Mandatory-Summary)
   ↓
P7  (Skill-Wrapper-Tools: attach/detach/put-with-attach)
   ↓
P8  (kc:// URI-Resolver in PWA-Markdown, mit DOMPurify-allow-list)
   ↓
P9  (Eager-Embed mit body_size-Budget + skills.get_bundle)
```

MUS bleibt **P1a + P1 + P2 + P6 + P4** — jetzt 5 statt 3 Phasen, ~3.5 PT statt 2.25 PT, aber inkl. IPI-Hardening und mit gefüllten Verknüpfungen ab Tag 1 (P6 vor P4).

### Schema-Migrations-Summary

Zwei DB-Migrations für diesen PLAN:

```sql
-- Migration 00XX_refs_hardening.sql
ALTER TABLE object_refs
  ADD CONSTRAINT object_refs_from_fk FOREIGN KEY (from_id) REFERENCES objects(id) ON DELETE CASCADE,
  ADD CONSTRAINT object_refs_to_fk   FOREIGN KEY (to_id)   REFERENCES objects(id) ON DELETE CASCADE;
DROP INDEX IF EXISTS idx_refs_role;
CREATE INDEX idx_refs_to_role ON object_refs(to_id, role);  -- für is_subdoc EXISTS-Check
DROP POLICY refs_via_object ON object_refs;
CREATE POLICY refs_via_object ON object_refs USING (
  EXISTS (SELECT 1 FROM objects WHERE objects.id = object_refs.from_id)
  AND EXISTS (SELECT 1 FROM objects WHERE objects.id = object_refs.to_id)
);

-- Migration 00YY_objects_is_subdoc.sql
ALTER TABLE objects ADD COLUMN is_subdoc boolean NOT NULL DEFAULT false;
CREATE INDEX idx_objects_is_subdoc ON objects(is_subdoc) WHERE is_subdoc = true;
-- Backfill (run once, idempotent):
UPDATE objects o SET is_subdoc = true
WHERE EXISTS (SELECT 1 FROM object_refs r WHERE r.to_id = o.id AND r.role = 'resource');
```

Backfill ist load-bearing für die 5 v1-Resource-Docs die Phase 6 migration anhängt — Reihenfolge: erst Migration läuft (column existiert, alte Daten backfilled), dann P6 läuft (legt neue Refs an, Toggle-Logic setzt `is_subdoc=true` automatisch).

## 11. Quellen (Research-Pass 2026-05-17)

## 11. Quellen (Research-Pass 2026-05-17)

- [MCP Specification 2025-11-25 — Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [Anthropic — Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Anthropic — Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
- [anthropics/skills GitHub](https://github.com/anthropics/skills)
- [GraphReader (arxiv 2406.14550)](https://arxiv.org/abs/2406.14550)
- [HippoRAG (arxiv 2405.14831)](https://arxiv.org/abs/2405.14831)
- [Extending ResourceLink: Patterns for Large Dataset Processing in MCP (arxiv 2510.05968)](https://arxiv.org/html/2510.05968v1)
- [Karpathy's LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- [GraphRAG vs LightRAG comparative](https://www.maargasystems.com/2025/05/12/understanding-graphrag-vs-lightrag-a-comparative-analysis-for-enhanced-knowledge-retrieval/)
- [Do You Really Need GraphRAG?](https://aiexpjourney.substack.com/p/do-you-really-need-graphrag-ai-innovations)
- v1-Vorlage: `mcp-approval/docs/plans/done/PLAN-search-subdocs.md` (gedankliche Basis für used_by/sub-docs-Annotation)
