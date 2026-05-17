/**
 * Renderer für `memo` — atomarer Plain-Text-Fact ohne Title.
 *
 * UX: kurzer `<p>` mit body + optional `scope`-Tag aus `metaJson`.
 */
import type { KnowledgeObject } from '../api-storage.js';
import { decodeBody } from './utils.js';

export function renderMemo(obj: KnowledgeObject): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'memo-card';

  const body = decodeBody(obj);
  const p = document.createElement('p');
  p.className = 'memo-body';
  p.textContent = body || '(leer)';
  wrapper.appendChild(p);

  const meta = obj.metaJson;
  const scope = meta && typeof meta === 'object' ? meta['scope'] : undefined;
  if (typeof scope === 'string' && scope.length > 0) {
    const tag = document.createElement('span');
    tag.className = 'scope-tag';
    tag.textContent = `scope: ${scope}`;
    wrapper.appendChild(tag);
  }
  return wrapper;
}
