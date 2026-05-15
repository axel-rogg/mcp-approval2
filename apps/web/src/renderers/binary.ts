/**
 * Renderer für Binary-Bodies — Images embedded via data-URL, alles andere als
 * Download-Card mit Filename / Size / Button.
 *
 * Body kommt entweder als base64 (typisch für binary) oder utf8 (raw text).
 * Wir machen aus beiden Varianten eine data-URL.
 */
import type { KnowledgeObject } from '../api-storage.js';

function bodyAsBase64(obj: KnowledgeObject): string {
  const body = obj.body ?? '';
  const encoding = obj.bodyEncoding ?? 'utf8';
  if (encoding === 'base64') return body;
  // utf8 → base64
  try {
    return btoa(unescape(encodeURIComponent(body)));
  } catch {
    return '';
  }
}

function formatBytes(n: number | undefined): string {
  if (n === undefined || n === null) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function renderBinary(obj: KnowledgeObject): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'binary-renderer';

  const mime = obj.contentType ?? 'application/octet-stream';
  const b64 = bodyAsBase64(obj);
  const dataUrl = b64 ? `data:${mime};base64,${b64}` : '';

  if (mime.startsWith('image/') && dataUrl) {
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = obj.filename ?? obj.title ?? obj.id;
    img.className = 'binary-image';
    wrapper.appendChild(img);
    return wrapper;
  }

  const card = document.createElement('div');
  card.className = 'binary-download';

  const name = document.createElement('div');
  name.className = 'binary-filename';
  name.textContent = obj.filename ?? obj.title ?? obj.id;
  card.appendChild(name);

  const size = document.createElement('div');
  size.className = 'binary-size muted';
  size.textContent = `${mime} · ${formatBytes(obj.bodySize)}`;
  card.appendChild(size);

  if (dataUrl) {
    const dl = document.createElement('a');
    dl.className = 'btn';
    dl.href = dataUrl;
    dl.download = obj.filename ?? `${obj.id}.bin`;
    dl.textContent = '⬇ Download';
    card.appendChild(dl);
  }

  wrapper.appendChild(card);
  return wrapper;
}
