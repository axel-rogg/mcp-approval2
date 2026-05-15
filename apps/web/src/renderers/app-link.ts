/**
 * Renderer für `app:*` Subtypes — Composable-App-Body (JSON-State) wird nicht
 * direkt gerendert. Stattdessen Link auf die apps-Detail-Surface.
 */
import type { KnowledgeObject } from '../api-storage.js';

export function renderAppLink(obj: KnowledgeObject): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'app-link-card';

  const subtype = obj.subtype ?? '';
  const appType = subtype.startsWith('app:') ? subtype.slice('app:'.length) : subtype;

  const info = document.createElement('p');
  info.className = 'muted';
  info.textContent = `App-Typ: ${appType || '(unbekannt)'}`;
  wrapper.appendChild(info);

  const link = document.createElement('a');
  link.className = 'btn';
  link.href = `#/apps/${encodeURIComponent(obj.id)}`;
  link.textContent = '→ App öffnen';
  wrapper.appendChild(link);

  return wrapper;
}
