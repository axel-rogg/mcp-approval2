# PWA Subtype-Renderer Plan

> **Status:** Draft 2026-05-15.
> **Repo:** mcp-approval2 PWA (`apps/web/`).
> **Voraussetzung:** ADR-0004 Generic Object Model deployed (siehe knowledge2/GENERIC-DATA-MODEL.md). PWA-Frontend ist heute generisch (Body als `<pre>` plaintext); subtype-spezifische Renderer fehlen.
> **Convention-Quelle:** [PLAN-wrapper-conventions.md](PLAN-wrapper-conventions.md) §"Body-Formate".

## Heutiger Stand

[storage-detail.ts:174-177](../../../apps/web/src/storage-detail.ts):
```typescript
const pre = document.createElement('pre');
pre.className = 'storage-body-pre';
pre.textContent = decodeBody(obj) || '(empty)';
bodySection.appendChild(pre);
```

Alle Subtypes (`file` Markdown, `list` Checkbox-Markdown, `note` Markdown, `memo` Plain-Text, `skill_manifest` Markdown+YAML, `app:*` JSON) werden identisch als Plain-Text in `<pre>` gerendert. Keine Subtype-Differenzierung. Edit-Pencil nur für `subtype === 'file'`.

[storage-tab.ts:284-285](../../../apps/web/src/storage-tab.ts) rendert nur Badge mit `data-subtype="..."`, keine subtype-spezifische List-Item-Anzeige.

## Ziel

Subtype-aware Renderer-Dispatch im Detail-View. Pro Subtype ein dezidierter Renderer mit angemessener UI:

| Subtype | Renderer | UX |
|---|---|---|
| `file` (mime=text/markdown) | Markdown→HTML | Headings, Listen, Code-Blocks, Links als HTML; raw-toggle für Source-Ansicht |
| `file` (mime=code) | Code-Block | Plaintext mit monospace + Zeilen-Nummern, optional Syntax-Highlighting (later) |
| `file` (mime=binary, image/*) | Image Embed | `<img>` mit `src=<blob-data-URL>` aus Body |
| `file` (mime=binary, andere) | Download | Filename + Size + Download-Button (Body als Blob serven) |
| `list` | Checkbox-UI | Read-only Checkbox-Liste (HTML `<input type="checkbox" disabled>`), Item-Tags als `<span class="tag">`. Toggle-Schreibzugriff später via `lists.tick`-Tool. |
| `note` | Markdown→HTML | Wie `file`/markdown |
| `memo` | Plain-Text-Karte | `<p>` mit body, plus `meta.scope`-Tag falls gesetzt. Title-less per Definition. |
| `skill_manifest` | YAML-Frontmatter + Markdown | Frontmatter-Block (slug/description/version/trigger_hints) als `<dl>`, Body als rendered Markdown |
| `app:*` | App-Link | Body=JSON wird nicht direkt rendert; Button "→ App öffnen" navigiert zu `#/apps/<id>` (existierende apps-detail-Surface) |

## Markdown-Renderer-Lib

Wir brauchen einen kleinen Markdown-Renderer. Optionen:

| Option | Bundle-Size | Features | Empfehlung |
|---|---|---|---|
| **`marked`** | ~38 KB min | GFM, Tables, Code-Blocks, sanitize-able | **Default** |
| `markdown-it` | ~70 KB min | mehr Plugins, langsamer | nein |
| micromark | ~20 KB min | low-level, brauche Renderer-Schicht | nein |
| Eigener Mini-Renderer | <5 KB | nur Headings/Listen/Code | nein (Maintenance-Schuld) |

**Default: `marked`** + DOMPurify für XSS-Sanitization (das ist user-content, KEIN Trust-Boundary).

Bundle-Impact: heute ~82 KB JS, post-bump ~120 KB JS. Akzeptabel.

## Datei-Plan

### Neu: `apps/web/src/renderers/`

```
renderers/
  index.ts          — dispatchRenderer(obj) → HTMLElement
  markdown.ts       — renderMarkdown(text) → HTMLElement (marked + DOMPurify)
  list.ts           — renderList(text) → HTMLElement (Checkbox-UI)
  memo.ts           — renderMemo(obj) → HTMLElement (Plain-Text-Karte)
  skill-manifest.ts — renderSkillManifest(text) → HTMLElement (YAML + Markdown)
  file-binary.ts    — renderBinary(obj) → HTMLElement (Image/Download)
  app-link.ts       — renderAppLink(obj) → HTMLElement (Navigate-Button)
```

### Bestehend: `apps/web/src/storage-detail.ts`

Body-Render-Block (Z.167-178) ersetzen durch:

```typescript
const bodySection = document.createElement('section');
bodySection.className = 'storage-body card';
const bh = document.createElement('h2');
bh.textContent = 'Body';
bodySection.appendChild(bh);

const body = dispatchRenderer(obj);  // NEU
bodySection.appendChild(body);

// Raw-Toggle (immer verfügbar als Fallback)
const rawToggle = document.createElement('details');
const summary = document.createElement('summary');
summary.textContent = 'Raw';
rawToggle.appendChild(summary);
const pre = document.createElement('pre');
pre.className = 'storage-body-pre';
pre.textContent = decodeBody(obj) || '(empty)';
rawToggle.appendChild(pre);
bodySection.appendChild(rawToggle);

main.appendChild(bodySection);
```

### Bestehend: `apps/web/src/styles.css`

Neue Styles:
- `.checkbox-list` — Checkbox-UI mit `gap`/`align-items: baseline`
- `.checkbox-list .tag` — Item-Tag Bubble (`#obst`, `#drogerie`)
- `.markdown-rendered` — Reset für rendered Markdown (`h1`/`h2`/`ul`/`code`/`pre` etc.)
- `.memo-card` — Memo-Karte mit `scope`-Tag
- `.skill-manifest-frontmatter` — `<dl>` Style für slug/description/version

## Dispatch-Logik

[apps/web/src/renderers/index.ts](../../../apps/web/src/renderers/index.ts) (NEU):

```typescript
import type { KnowledgeObject } from '../api-storage';

export function dispatchRenderer(obj: KnowledgeObject): HTMLElement {
  const subtype = obj.subtype ?? '';
  const body = decodeBody(obj);

  // app:* (Namespace-Prefix)
  if (subtype.startsWith('app:')) {
    return renderAppLink(obj);
  }

  switch (subtype) {
    case 'file': {
      const mime = obj.mimeType ?? 'text/plain';
      if (mime.startsWith('text/markdown')) return renderMarkdown(body);
      if (mime.startsWith('image/')) return renderBinary(obj);
      if (mime.startsWith('application/octet-stream')) return renderBinary(obj);
      return renderPlainCode(body, obj.meta?.language);
    }
    case 'list': return renderList(body);
    case 'note': return renderMarkdown(body);
    case 'memo': return renderMemo(obj);
    case 'skill_manifest': return renderSkillManifest(body);
    default: return renderFallback(body);  // generic <pre>
  }
}
```

## Phasen

### Phase 1 — Markdown-Renderer (file/note/skill_manifest)

1. `npm install marked dompurify @types/marked @types/dompurify --workspace=apps/web`
2. `renderers/markdown.ts` schreiben
3. `renderers/skill-manifest.ts` (YAML-Frontmatter parsing + Markdown)
4. `renderers/index.ts` mit Dispatch
5. CSS-Reset für `.markdown-rendered`
6. Wire in `storage-detail.ts`
7. Build + tsc grün

### Phase 2 — List-Renderer (Checkbox-UI)

1. `renderers/list.ts` — parse Markdown-Checkbox-Pattern (`^- \[[ xX]\] (.+?)( #[a-z0-9_-]+)*$`), render `<input type="checkbox" disabled checked={isChecked}>` + label
2. Item-Tags als `<span class="tag">#obst</span>`
3. H1 als Header
4. CSS für `.checkbox-list`

### Phase 3 — Memo + App-Link + Binary

1. `renderers/memo.ts` — `<p>` mit body, `<span class="scope-tag">` falls `meta.scope`
2. `renderers/app-link.ts` — Button mit `window.location.hash = '#/apps/<id>'`
3. `renderers/file-binary.ts` — Image-Embed bei `image/*` (data-URL aus body-bytes), Download-Button sonst

### Phase 4 — Verify + Polish

1. Manuell PWA-Build laufen lassen, alle Subtypes durchklicken (falls Test-Daten verfügbar — sonst Mock-Objects in storage-tab erstellen)
2. CSS-Polish (Spacing, Farben passend zu existierenden Cards)
3. Tests: kleine Unit-Tests für Renderer-Dispatch (Pure-Function-Tests)

## XSS / Security

Markdown-Renderer wird `marked` + DOMPurify nutzen:

```typescript
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function renderMarkdown(text: string): HTMLElement {
  const html = marked.parse(text, { gfm: true, breaks: false });
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'code', 'pre', 'a', 'strong', 'em', 'blockquote', 'br', 'hr', 'table', 'thead', 'tbody', 'tr', 'td', 'th'],
    ALLOWED_ATTR: ['href', 'class'],
  });
  const wrapper = document.createElement('div');
  wrapper.className = 'markdown-rendered';
  wrapper.innerHTML = clean;
  return wrapper;
}
```

**Wichtig:** Storage liefert User-erzeugten Content. PWA ist Same-Origin mit der Approval-Surface — XSS hier könnte Approval-Decision-Buttons hijacken. DOMPurify ist **kein optional**.

## Bundle-Impact

Erwartet: +40-50 KB gzipped (`marked` + `dompurify`).
Heute: 22 KB gzipped → nach: ~70 KB gzipped. Akzeptabel für eine PWA mit Markdown-Rendering.

## Out-of-scope

- Syntax-Highlighting für Code-Blocks (Highlight.js / Prism) — separater Folge-PR
- Schreibzugriff auf Lists (Toggle-Checkbox triggert `lists.tick`-Tool) — Folge-PR mit Tool-Wrapper-Implementation
- App-Embed (statt App-Link) für `app:*`-Subtypes — Composable-Apps-Block-Rendering ist eigenes Sub-System
- Image-Crop/Zoom für Binary-Image-Renderer — out-of-scope

## Definition of Done

- 6 Subtype-Renderer + Fallback implementiert
- Dispatch wired in storage-detail.ts
- CSS-Styles für jede Renderer-Variante
- Build grün, Tests grün (mind. ein Unit-Test pro Renderer)
- DOMPurify-Sanitization eingebaut für Markdown
- Bundle-Size in PR-Description dokumentiert (vorher/nachher)
