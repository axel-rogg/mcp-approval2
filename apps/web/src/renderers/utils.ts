/**
 * Shared helpers für Subtype-Renderer.
 *
 * `decodeBody` ist die einzige Quelle für Body-Decoding (utf8 oder base64).
 *
 * Bug-Fix 2026-05-17: bisheriger Code prüfte `[\x09\x0a\x0d\x20-\x7e]` (=
 * ASCII-only) und fiel bei UTF-8-Multibyte (Umlaute, Em-Dash, Emojis) auf
 * den Hex-Preview-Pfad zurück. Resultat: Markdown mit `ä/ö/ü/—` wurde als
 * "verschlüsselter" Hex-Dump angezeigt.
 *
 * Neuer Pfad: base64 → Uint8Array → TextDecoder('utf-8', fatal:false).
 * `fatal:false` ersetzt malformed bytes mit U+FFFD (`�`) statt zu throwen —
 * Edge-Case "binary-mit-text-mimetype" zeigt Replacement-Chars statt
 * Crash. Echte Binary-Files (image/*, application/octet-stream) werden
 * bereits von dispatchRenderer auf `renderBinary` geroutet — landen also
 * nicht hier.
 */
import type { KnowledgeObject } from '../api-storage.js';

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

export function decodeBody(obj: KnowledgeObject): string {
  if (!obj.body) return '';
  const encoding = obj.bodyEncoding ?? 'utf8';
  if (encoding === 'utf8') return obj.body;
  if (encoding === 'base64') {
    try {
      const binary = atob(obj.body);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const text = TEXT_DECODER.decode(bytes);
      // Heuristic: if the decoded text contains a high density of NUL or
      // control bytes (>5%), it's likely binary garbage rather than valid
      // text. Fall back to a hex preview.
      if (looksBinary(text)) {
        return hexPreview(bytes);
      }
      return text;
    } catch {
      return '<unable to decode base64 body>';
    }
  }
  return obj.body;
}

function looksBinary(s: string): boolean {
  if (s.length === 0) return false;
  let control = 0;
  const sample = s.slice(0, Math.min(s.length, 1024));
  for (const ch of sample) {
    const c = ch.charCodeAt(0);
    // Allow tab (9), LF (10), CR (13). Everything else < 32 is suspicious.
    if (c === 0 || (c < 32 && c !== 9 && c !== 10 && c !== 13)) control++;
  }
  return control / sample.length > 0.05;
}

function hexPreview(bytes: Uint8Array): string {
  const cap = Math.min(bytes.length, 256);
  let hex = '';
  for (let i = 0; i < cap; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0') + ' ';
  }
  return `<binary, ${bytes.length} bytes>\n${hex}${bytes.length > cap ? '…' : ''}`;
}
