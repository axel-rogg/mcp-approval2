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

/**
 * Detect content-kind for renderer dispatch.
 *
 * PLAN-doc-linking 2026-05-17 (post-deploy User-Feedback): unified body
 * rendering. Pipeline:
 *   1. `obj.mimeType` (or legacy alias `obj.contentType`)
 *   2. Filename-Extension fallback (`.md` → markdown, `.py` → python, ...)
 *   3. Default `text/plain` → code-renderer with autodetect
 *
 * `kind` is the visual category:
 *   - 'markdown' → marked + highlight.js for fenced code
 *   - 'code'     → highlight.js single-language pre block
 *   - 'image'    → renderBinary inline-image
 *   - 'binary'   → renderBinary hex-dump
 *   - 'plain'    → renderCode w/o language (still goes through hljs autodetect)
 *
 * `lang` carries the hljs-friendly language id for code-kind.
 */
export interface ContentKind {
  readonly kind: 'markdown' | 'code' | 'image' | 'binary' | 'plain';
  readonly lang?: string;
}

const EXT_TO_LANG: Record<string, { kind: ContentKind['kind']; lang?: string }> = {
  md: { kind: 'markdown' },
  markdown: { kind: 'markdown' },
  json: { kind: 'code', lang: 'json' },
  yaml: { kind: 'code', lang: 'yaml' },
  yml: { kind: 'code', lang: 'yaml' },
  toml: { kind: 'code', lang: 'toml' },
  xml: { kind: 'code', lang: 'xml' },
  html: { kind: 'code', lang: 'xml' },
  htm: { kind: 'code', lang: 'xml' },
  css: { kind: 'code', lang: 'css' },
  scss: { kind: 'code', lang: 'scss' },
  py: { kind: 'code', lang: 'python' },
  python: { kind: 'code', lang: 'python' },
  js: { kind: 'code', lang: 'javascript' },
  mjs: { kind: 'code', lang: 'javascript' },
  cjs: { kind: 'code', lang: 'javascript' },
  ts: { kind: 'code', lang: 'typescript' },
  tsx: { kind: 'code', lang: 'typescript' },
  jsx: { kind: 'code', lang: 'javascript' },
  sql: { kind: 'code', lang: 'sql' },
  sh: { kind: 'code', lang: 'bash' },
  bash: { kind: 'code', lang: 'bash' },
  zsh: { kind: 'code', lang: 'bash' },
  go: { kind: 'code', lang: 'go' },
  rs: { kind: 'code', lang: 'rust' },
  rb: { kind: 'code', lang: 'ruby' },
  java: { kind: 'code', lang: 'java' },
  c: { kind: 'code', lang: 'c' },
  cpp: { kind: 'code', lang: 'cpp' },
  cs: { kind: 'code', lang: 'csharp' },
  txt: { kind: 'plain' },
  log: { kind: 'plain' },
};

const MIME_TO_LANG: Array<[RegExp, { kind: ContentKind['kind']; lang?: string }]> = [
  [/^text\/markdown/i, { kind: 'markdown' }],
  [/^application\/json/i, { kind: 'code', lang: 'json' }],
  [/^text\/x-yaml|application\/.*yaml/i, { kind: 'code', lang: 'yaml' }],
  [/^text\/html/i, { kind: 'code', lang: 'xml' }],
  [/^text\/css/i, { kind: 'code', lang: 'css' }],
  [/^text\/javascript|application\/javascript/i, { kind: 'code', lang: 'javascript' }],
  [/^application\/typescript/i, { kind: 'code', lang: 'typescript' }],
  [/^application\/x-sql|text\/x-sql/i, { kind: 'code', lang: 'sql' }],
  [/^application\/x-python|text\/x-python/i, { kind: 'code', lang: 'python' }],
  [/^application\/x-sh|text\/x-shellscript/i, { kind: 'code', lang: 'bash' }],
  [/^image\//i, { kind: 'image' }],
  [/^application\/octet-stream/i, { kind: 'binary' }],
];

export function detectContentKind(args: {
  mimeType?: string | null;
  filename?: string | null;
}): ContentKind {
  // 1. MimeType wins.
  const m = (args.mimeType ?? '').trim();
  if (m) {
    for (const [re, hit] of MIME_TO_LANG) {
      if (re.test(m)) return { kind: hit.kind, ...(hit.lang ? { lang: hit.lang } : {}) };
    }
    // text/* with unknown subtype → code with autodetect
    if (/^text\//i.test(m)) return { kind: 'code' };
    if (/^application\/x-/i.test(m)) return { kind: 'code' };
  }
  // 2. Filename extension fallback.
  const fn = (args.filename ?? '').trim();
  if (fn) {
    const ext = fn.slice(fn.lastIndexOf('.') + 1).toLowerCase();
    if (ext && ext !== fn) {
      const hit = EXT_TO_LANG[ext];
      if (hit) return { kind: hit.kind, ...(hit.lang ? { lang: hit.lang } : {}) };
    }
  }
  // 3. Default plain.
  return { kind: 'plain' };
}
