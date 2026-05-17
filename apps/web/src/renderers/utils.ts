/**
 * Shared helpers für Subtype-Renderer.
 *
 * `decodeBody` ist die einzige Quelle für Body-Decoding (utf8 oder base64).
 * Identisch zu storage-detail.ts, hier zentralisiert damit Renderer den Body
 * abrufen können ohne auf das parent-Modul angewiesen zu sein.
 */
import type { KnowledgeObject } from '../api-storage.js';

export function decodeBody(obj: KnowledgeObject): string {
  if (!obj.body) return '';
  const encoding = obj.bodyEncoding ?? 'utf8';
  if (encoding === 'utf8') return obj.body;
  if (encoding === 'base64') {
    try {
      const decoded = atob(obj.body);
      if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(decoded)) return decoded;
      let hex = '';
      for (let i = 0; i < Math.min(decoded.length, 256); i++) {
        hex += decoded.charCodeAt(i).toString(16).padStart(2, '0') + ' ';
      }
      return `<binary, ${decoded.length} bytes>\n${hex}${decoded.length > 256 ? '…' : ''}`;
    } catch {
      return '<unable to decode base64 body>';
    }
  }
  return obj.body;
}
