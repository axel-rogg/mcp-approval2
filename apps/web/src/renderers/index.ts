/**
 * Subtype-Renderer-Dispatch — Eingangspunkt für storage-detail.
 *
 * Konvention (PLAN-wrapper-conventions.md):
 *   - `doc` → Markdown (text/markdown), Image-Embed (image/*), Plain-Code sonst
 *   - `note` → Markdown
 *   - `list` → Checkbox-UI
 *   - `memo` → Plain-Text-Karte mit scope-Tag
 *   - `skill_manifest` → YAML-Frontmatter + Markdown-Body
 *   - `app:*` → App-Link (Navigate-Button)
 *   - sonst → Fallback `<pre>`
 */
import type { KnowledgeObject } from '../api-storage.js';
import { renderAppLink } from './app-link.js';
import { renderBinary } from './binary.js';
import { renderList } from './list.js';
import { renderMarkdown } from './markdown.js';
import { renderMemo } from './memo.js';
import { renderSkillManifest } from './skill-manifest.js';
import { decodeBody } from './utils.js';

export function dispatchRenderer(obj: KnowledgeObject): HTMLElement {
  const subtype = obj.subtype ?? '';

  if (subtype.startsWith('app:')) {
    return renderAppLink(obj);
  }

  switch (subtype) {
    case 'doc': {
      const mime = obj.contentType ?? 'text/plain';
      if (mime.startsWith('text/markdown')) return renderMarkdown(decodeBody(obj));
      if (mime.startsWith('image/')) return renderBinary(obj);
      if (mime.startsWith('application/octet-stream')) return renderBinary(obj);
      return renderPlainText(decodeBody(obj));
    }
    case 'list':
      return renderList(decodeBody(obj));
    case 'note':
      return renderMarkdown(decodeBody(obj));
    case 'memo':
      return renderMemo(obj);
    case 'skill_manifest':
      return renderSkillManifest(decodeBody(obj));
    default:
      return renderFallback(decodeBody(obj));
  }
}

function renderPlainText(text: string): HTMLElement {
  const pre = document.createElement('pre');
  pre.className = 'storage-body-pre plain-text';
  pre.textContent = text || '(empty)';
  return pre;
}

function renderFallback(text: string): HTMLElement {
  const pre = document.createElement('pre');
  pre.className = 'storage-body-pre fallback';
  pre.textContent = text || '(empty)';
  return pre;
}
