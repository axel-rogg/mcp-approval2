# Wrapper-Conventions — Subtype-Liste + Body-Formate

> **Status:** ✅ Live 2026-05-15 — initial pass nach ADR-0004 (Generic Object Model in mcp-knowledge2).
> **Repo:** mcp-approval2 (Caller). Storage ist mcp-knowledge2.
> **Plan-Klasse:** Konvention-Spec, kein Implementation-Brief. Wird gepflegt wenn neue Wrapper dazukommen.
> **Quelle für KC2-side:** [knowledge2/GENERIC-DATA-MODEL.md](https://github.com/axel-rogg/mcp-knowledge2/blob/feat/as3-cutover/GENERIC-DATA-MODEL.md) (Brief v3) + ADR-0004.

## Warum dieses Dokument

ADR-0004 hat `kind` aus mcp-knowledge2 entfernt. `subtype` ist jetzt free-form Caller-Convention ohne DB-Enforcement (nur `^[a-z][a-z0-9_:-]{0,31}$` als Form-Guard). Damit verschiedene Caller (Tools, PWA, Cron-Jobs) nicht unterschiedliche Strings für dasselbe Konzept benutzen (`'list'` vs `'lists'` vs `'shopping_list'`), pflegen wir hier die **kanonische Liste empfohlener Subtypes** plus Body-Format-Specs.

Storage interpretiert NICHTS — diese Konventionen sind Wrapper-side enforced (zod-Validation im Tool-Layer).

## Subtype-Tabelle

| Subtype | Zweck | Body-Format | Title-Pflicht | Mutation | searchable_vector empfohlen | Cross-Object-Refs | shareable |
|---|---|---|---|---|---|---|---|
| `file` | Datei (Markdown/Code/Binary, ID-basiert) | text/markdown UTF-8, code mit `meta_json.language`, binary mit R2-overflow | ja | full_replace | optional (User-flag bei `description`) | als ref-target erlaubt | ja |
| `list` | Items mit Done-Flag (Einkaufsliste, Reading-List, Todo) | Markdown-Checkbox-Pattern (siehe §"Body-Formate" unten) | ja | full_replace (CAS-Retry server-internal) | nein | nein | ja |
| `note` | Strukturierte Notiz (Markdown, frei) | Markdown ohne strikte Struktur | ja | full_replace | optional (User-flag) | nein | ja |
| `memo` | Atomare Facts für semantic recall ("User hat zwei Kinder") | Plain-Text 1..500 chars | nein (titleless) | append-only (immutable + soft-delete) | **ja** (default true bei `memorize.add`) | nein | ja |
| `skill_manifest` | Skill-Bundle (Markdown + YAML-Frontmatter + refs zu file-Resources) | Markdown + YAML-Frontmatter | ja | full_replace + revisions table | ja (default) | **ja** (`object_refs(role='skill_resource')` zu `subtype='file'`) | ja |
| `app:<typ>` | App-Instance-State (Composable Apps, Workout-Tracker, etc.) | JSON LayoutDoc (A2UI v0.10) | ja | CAS-Patches via `current_version` | nein | nein | **nein in Phase 1** (CAS + interactive State erfordert OT/CRDT) |
| `bookmark` | URL-Bookmark mit Title + Description (hypothetisch, noch nicht implementiert) | URL plus Markdown-Notes | ja | full_replace | optional | nein | ja |
| `recipe` | Kochrezept (hypothetisch) | Markdown mit YAML-Frontmatter (Zutaten/Schritte) | ja | full_replace | optional | nein | ja |

**Erweiterbarkeit:** Neue Subtypes können jederzeit hinzugefügt werden ohne Schema-Migration. Caller-Konvention: snake_case oder kebab-case, max 32 chars, alphanumerisch + `_`/`-`/`:`. Eintrag in dieser Tabelle ist Pflicht (Code-Review-Regel).

## App-Subtype-Namespacing

Apps sind **die einzige Subtype-Familie mit `:`-Prefix**. Begründung in ADR-0004 + Brief §6.1:

- Heute (vor ADR-0004) waren Apps zweistufig: `kind='app', subtype=<typ>` (z.B. `subtype='composable'`)
- Mit `kind`-Drop kollidiert das: `subtype='composable'` ohne Namespace ist zu generisch
- Lösung: Subtype-Namespacing mit `app:`-Prefix. Beispiele:
  - `app:composable` — Composable-App-Instance (A2UI-LayoutDoc)
  - `app:shopping-list` — Einkaufslisten-App (wenn als App und nicht als `subtype=list` modelliert)
  - `app:workout-tracker`, `app:meditation-timer`, `app:reading-log` — die historischen Composable-Types

Helpers in [apps/server/src/apps/api.ts](../../../apps/server/src/apps/api.ts):
- `appSubtype(appType: string): string` → `app:${appType}`
- `appTypeFromSubtype(subtype: string): string | undefined` → `<typ>` falls `app:<typ>`, sonst undefined
- `isAppObject(obj: { subtype?: string | null }): boolean` → `obj.subtype?.startsWith('app:')`

Wer App-Objects findet/filtert nutzt diese Helper, nicht String-Manipulation per se.

## Body-Formate (Wrapper-side Validation)

Storage akzeptiert opaque ciphertext. Wrapper validiert das Body-Format VOR dem POST/PATCH gegen Storage.

### `subtype='file'`

Body kann sein:
- **Markdown** (text/markdown UTF-8, max 16 KB inline, sonst R2-overflow)
- **Code** (Plain-Text mit `meta_json.body_format='code'` + `meta_json.language` für Syntax-Hint)
- **Binary** (PDFs, Images — `meta_json.body_format='binary'`, R2-overflow ab 16 KB ciphertext)

`title` als Pseudo-Filename, `description` als optional Summary für Vector-Embed.

### `subtype='list'`

Body ist Markdown-Checkbox-Items:

```markdown
# Einkauf

- [ ] Tomaten
- [ ] Brot #obst
- [x] Käse
- [ ] Avocado #obst
```

**Wrapper-Validator** (zod / Tool-Layer):
- Erste Zeile: optional `^# .+$` (H1-Header, wird als Title übernommen falls `title` leer)
- Item-Zeilen: `^- \[[ xX]\] .+( #[a-zA-Z0-9_-]{1,32})?$` (Tag-Suffix optional)
- Leerzeilen zwischen Header und Items erlaubt
- Max 120 Items (~16 KB plaintext)

**Toggle-Semantik:** `lists.tick`-Tool flippt `[ ]` ↔ `[x]` durch text-replace auf der gefundenen Zeile. Item-Identifikation via text-substring (case-insensitive) oder Zeilen-Index. Kein server-seitiges Item-Schema, kein eigener ID-Mechanismus pro Item.

**Item-Tags:** `#tagname` am Zeilenende (z.B. `#obst`, `#drogerie`). Optional, Convention für Caller-side-Filter.

### `subtype='note'`

Body ist Markdown ohne strikte Struktur. Title separat in `objects.title` (plaintext).

Empfohlene Top-Level-Sections via H2/H3. Markdown-Render im PWA. Optional Vector-Embed via `embed=true` Request (User entscheidet pro Note).

Constraints: max 16 KB inline (R2-overflow möglich für lange Notizen). Keine Cross-Object-Refs in Phase 1.

### `subtype='memo'`

Body ist Plain-Text (1..500 chars, kein Markdown). Title-less per Definition.

**Pflicht beim Create:**
- `embed=true` (Vector-Embed wird im KC2-Insert-Handler getriggert)
- `description` MUSS gesetzt sein (sonst keine Vector-Source)

`memorize.add` setzt das automatisch. `memorize.search` macht Hybrid-Search (FTS + Vector + RRF). Time-Decay-Score wäre Wrapper-side post-fetch (nicht in Phase 1 implementiert).

**Subtype-Sub-Discriminator (optional):** Memos können `meta_json.scope='work'|'private'|...` für grobe Gruppierung. Kein Schema-Enforcement, freie Caller-Convention. Filter aktuell post-fetch (SearchHit hat keine `meta`-Projektion — `list_recent` ist verlässlich für Scope-Filter).

### `subtype='skill_manifest'`

Body ist Markdown mit YAML-Frontmatter:

```markdown
---
slug: lists-curator
description: Verwaltung von Lists und Sharing-Konventionen
trigger_hints: [liste, einkauf, abhaken, todo]
version: 1
---

# Lists Curator

Du kuratierst die Listen des Users...
```

**Wrapper-Validator-Schema:**
- `slug`: required, kebab-case, max 64 chars
- `description`: optional, 1..500 chars
- `trigger_hints`: optional, Array von Strings
- `version`: optional, integer >= 1

**Refs:** Skill-Resources via `object_refs(role='skill_resource', from_id=skill, to_id=file)`. Native Routes in KC2 (`/v1/objects/:id/refs` o.ä.).

**Discovery:** FTS5 auf Title + Description + Keywords + Trigger-Hints. Vector-Embed (`embed=true`) default.

### `subtype='app:<typ>'`

Body ist **JSON LayoutDoc**:

```jsonc
{
  "version": "v0.10",
  "components": [
    {"id": "hdr", "block": "header", "config": {"title": "..."}},
    {"id": "items", "block": "list", "config": {}}
  ],
  "state": {
    "hdr": {"title": "...", "subtitle": null},
    "items": {"items": [...]}
  },
  "meta": {}
}
```

**Mutation:** über CAS-Patches (`current_version` als CAS-Token). Keine `full_replace` für interactive Apps. Tools dispatchen Block-Actions, der Wrapper validiert + patcht atomar gegen KC2.

**Sharing in Phase 1: nein.** CAS-Race zwischen 2 Usern + Live-State-Sync braucht OT/CRDT-Sub-System. Wrapper `apps.share` wirft 400 BAD_REQUEST. Storage selbst erlaubt es (Wrapper-Reject, nicht Storage-Reject).

## Drift-Prevention

`subtype` ist free-form. Verschiedene Caller können unterschiedliche Strings für dasselbe Konzept nutzen. Vier Gegenmaßnahmen:

1. **Diese Tabelle ist kanonische Quelle.** Neue Subtypes brauchen Eintrag hier (Code-Review-Regel).
2. **Wrapper exportieren Subtype-Konstanten** statt String-Literals. Beispiele:
   - `const FILE_SUBTYPE = 'file'` in `apps/server/src/tools/docs-tools.ts`
   - `appSubtype('composable')` returnt `'app:composable'` aus den apps/api.ts-Helpers
3. **3 Zod-Schemas sind heute sync** (`tools/types.ts` ist Quelle, `federated-search-tool.ts` importiert, `routes/knowledge-proxy.ts` ist eigene Definition). Bonus-Folge-PR: alle drei auf einen einzigen Adapter-Package-Export konsolidieren.
4. **Migration-Script falls Drift trotzdem passiert** (billig, kein Re-Encrypt):
   ```sql
   UPDATE objects SET subtype='list' WHERE subtype IN ('lists', 'shopping_list');
   ```

## Konkurrierende Wrapper mit unterschiedlichen Body-Annahmen

Wenn Wrapper-A `subtype='list'` mit Markdown-Checkbox erwartet und Wrapper-B `subtype='list'` mit JSON-Array, kollidieren die Read-Pfade. Das ist ein **Caller-Bug** (diese Convention-Doku verletzt), kein Storage-Problem. Storage liefert den Body wie er reingekommen ist; Wrapper muss damit umgehen oder erkennen dass es nicht "seins" ist.

## Wrapper-Lifecycle

| Phase | Was passiert |
|---|---|
| **Hinzufügen** | Neue Tool-File in `apps/server/src/tools/<wrapper>/`, Eintrag in Tool-Registry, Eintrag in dieser Tabelle |
| **Versionierung** | Wrapper hat eigene Tool-Version. KC2 hat API-Version (`/v1/*`). Beide entkoppelt. |
| **Migration (Body-Format-Change)** | Wrapper schreibt One-shot-Script: alle `subtype='list'`-Objects via Storage-API lesen, transformieren, schreiben |
| **Deprecation** | Tool im Wrapper-Repo deprecated, Storage-Daten bleiben |
| **Removal** | Wrapper raus, Storage-Daten optional via `DELETE FROM objects WHERE subtype='X'` (Caller-initiated) |

## Anti-Patterns

- ❌ Wrapper macht eigene Crypto (Storage encrypted, AAD generiert KC2)
- ❌ Wrapper liest direkt aus Postgres (nur HTTP gegen KC2-API)
- ❌ Wrapper enforced Storage-Constraints (Wrapper kann zusätzlich, nicht duplizieren)
- ❌ Wrapper hardcoded Subtype-String ohne Eintrag hier
- ❌ Wrapper "darf nicht für Subtype X" als Storage-Reject (Wrapper-Reject = HTTP 400 vom Tool, Storage erlaubt's)
- ❌ Wrapper mutiert KC2-Schema

## Folge-Tickets

- **Tool-Wrapper-Implementations** (`lists.*`, `notes.*`, `bookmarks.*`, `recipes.*`) — heute existiert nur `memorize.*` + `docs.*` + `skills.*` + `apps.*`. Neue Wrapper folgen den Specs hier.
- **PWA-Renderer pro Subtype** — list-Checkbox-UI, note-Markdown-Render, memo-View-List, skill-Manifest-View. Heute generisch via `obj.subtype`-Badge.
- **`subtype_prefix=` Query-Param in KC2** für effiziente `app:`-Familie-Filter und `memo:work`-Scope-Filter (heute client-side, kostet Performance bei großen Datasets).
- **Konsolidierung der 3 Zod-Schemas** auf einen Adapter-Package-Export (siehe Drift-Prevention §3).
