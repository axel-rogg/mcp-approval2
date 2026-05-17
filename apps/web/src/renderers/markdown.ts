/**
 * Markdown-Renderer für `doc` (text/markdown), `note` und Bodies in
 * `skill_manifest` (after Frontmatter-Strip).
 *
 * Pipeline: marked → HTML → DOMPurify (XSS-Sanitize) → kc://-Resolve →
 *   <div class="markdown-rendered">.
 *
 * DOMPurify ist Pflicht — die PWA ist same-origin mit der Approval-Surface;
 * ein eingeschleustes `<script>` oder Event-Handler im User-Content könnte
 * Approval-Buttons hijacken. Tag/Attribute-Allowlist ist konservativ.
 *
 * `kc://`-URI-Resolver (PLAN-document-linking §10.5 D1, P8): nach DOMPurify
 * (mit erweiterter ALLOWED_URI_REGEXP) wandelt ein TreeWalker `<a href="kc://
 * object/<uuid>">` zu `<a href="#/storage/<uuid>">`. Strict whitelist gegen
 * malformed URIs.
 */
import DOMPurify from 'dompurify';
import { marked } from 'marked';

const ALLOWED_TAGS = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'code',
  'pre',
  'a',
  'strong',
  'em',
  'blockquote',
  'br',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
  'span',
] as const;

const ALLOWED_ATTR = ['href', 'class', 'title'] as const;

// PLAN-doc-linking P8: DOMPurify-Default-Allowlist erlaubt http/https/mailto/
// tel/ftp/sms. Wir whitelist'en zusätzlich `kc:` damit unsere kc://object/<uuid>-
// Links nicht gestrippt werden. Strikte Form via Regex — alles andere fällt
// auf den Default-Filter zurück (javascript:, data: etc. werden weiterhin
// gestripped).
const ALLOWED_URI_REGEXP =
  /^(?:(?:https?|ftp|mailto|tel|sms):|kc:\/\/object\/[0-9a-f-]{36}(?:#[a-zA-Z0-9_-]+)?$|#)/i;

const KC_URI_REGEX = /^kc:\/\/object\/([0-9a-f-]{36})(?:#([a-zA-Z0-9_-]+))?$/i;

/**
 * Resolve `kc://object/<uuid>` to PWA-internal hash-route `#/storage/<uuid>`.
 * Strict pattern match — invalid kc:-URIs leave the href untouched (DOMPurify
 * has already vetted the schema is allowed; bad UUIDs just become dead links).
 */
function resolveKcLinks(root: HTMLElement): void {
  const anchors = root.querySelectorAll('a[href^="kc://"]');
  anchors.forEach((a) => {
    const href = a.getAttribute('href');
    if (!href) return;
    const m = href.match(KC_URI_REGEX);
    if (!m) return; // malformed kc:-URI — leave as-is, DOMPurify already passed it
    const uuid = m[1];
    const anchor = m[2];
    a.setAttribute('href', `#/storage/${uuid}${anchor ? `#${anchor}` : ''}`);
    a.classList.add('kc-link');
    if (!a.getAttribute('title')) {
      a.setAttribute('title', `Storage-Objekt ${uuid}`);
    }
  });
}

export function renderMarkdown(text: string): HTMLElement {
  const html = marked.parse(text ?? '', { gfm: true, breaks: false, async: false }) as string;
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR],
    ALLOWED_URI_REGEXP,
  });
  const wrapper = document.createElement('div');
  wrapper.className = 'markdown-rendered';
  wrapper.innerHTML = clean;
  // Post-Purify Rewrite — DOMPurify hat bereits den schema-whitelist-check
  // gemacht; wir rewriten nur kc://-Form auf hash-route.
  resolveKcLinks(wrapper);
  return wrapper;
}
