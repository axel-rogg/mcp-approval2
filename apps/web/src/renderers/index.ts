/**
 * Subtype-Renderer-Dispatch — Eingangspunkt für storage-detail.
 *
 * PLAN-doc-linking 2026-05-17 (post-deploy User-Feedback "einheitliche
 * Body-Darstellung"): Dispatch ist jetzt 2-stufig — Subtype-Discriminator
 * für nicht-doc-Subtypes (list/note/memo/skill_manifest/app:*), und für
 * `doc` läuft `detectContentKind` (mimeType → filename-extension → plain)
 * gegen einen einheitlichen markdown/code/image/binary/plain-Output.
 *
 * Alle Renderer produzieren ein `<div class="body-content ...">` als
 * Outer-Wrapper — kein nested Border/Background, der Body-Card (storage-
 * detail.ts) ist der einzige sichtbare Rahmen. CSS in styles.css ←
 * single source of truth für padding/scroll.
 *
 * Konvention (PLAN-wrapper-conventions.md):
 *   - `doc` → detectContentKind dispatched
 *   - `note` → Markdown
 *   - `list` → Checkbox-UI
 *   - `memo` → Plain-Text-Karte mit scope-Tag
 *   - `skill_manifest` → YAML-Frontmatter + Markdown-Body
 *   - `app:*` → App-Link (Navigate-Button)
 *   - sonst → Fallback (code-rendered, autodetect)
 */
import type { KnowledgeObject } from '../api-storage.js';
import { renderAppLink } from './app-link.js';
import { renderBinary } from './binary.js';
import { renderCode } from './code.js';
import { renderList } from './list.js';
import { renderMarkdown } from './markdown.js';
import { renderMemo } from './memo.js';
import { renderSkillManifest } from './skill-manifest.js';
import { decodeBody, detectContentKind } from './utils.js';

function readMeta(obj: KnowledgeObject): Record<string, unknown> {
  return (obj.meta ?? obj.metaJson ?? {}) as Record<string, unknown>;
}

export function dispatchRenderer(obj: KnowledgeObject): HTMLElement {
  const subtype = obj.subtype ?? '';

  if (subtype.startsWith('app:')) {
    return renderAppLink(obj);
  }

  switch (subtype) {
    case 'list':
      return renderList(decodeBody(obj));
    case 'note':
      return renderMarkdown(decodeBody(obj));
    case 'memo':
      return renderMemo(obj);
    case 'skill_manifest':
      return renderSkillManifest(decodeBody(obj));
    case 'doc':
    default: {
      // Unified body detect — mimeType OR filename-extension OR plain.
      // contentType is a legacy alias readable from the same field.
      const mime = obj.mimeType ?? obj.contentType ?? null;
      const filename =
        obj.filename ??
        ((readMeta(obj)['filename'] as string | undefined) ?? null);
      const detected = detectContentKind({ mimeType: mime, filename });

      switch (detected.kind) {
        case 'markdown':
          return renderMarkdown(decodeBody(obj));
        case 'image':
          return renderBinary(obj);
        case 'binary':
          return renderBinary(obj);
        case 'code':
          return renderCode(decodeBody(obj), detected.lang);
        case 'plain':
        default:
          // Plain text auch durch renderCode (hljs autodetect tut nichts
          // schlimm bei reinem Text — bleibt monospace, vereinheitlicht
          // visuell die Card-Darstellung).
          return renderCode(decodeBody(obj));
      }
    }
  }
}
