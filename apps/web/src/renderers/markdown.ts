/**
 * Markdown-Renderer für `doc` (text/markdown), `note` und Bodies in
 * `skill_manifest` (after Frontmatter-Strip).
 *
 * Pipeline: marked → HTML → DOMPurify (XSS-Sanitize) → <div class="markdown-rendered">.
 *
 * DOMPurify ist Pflicht — die PWA ist same-origin mit der Approval-Surface;
 * ein eingeschleustes `<script>` oder Event-Handler im User-Content könnte
 * Approval-Buttons hijacken. Tag/Attribute-Allowlist ist konservativ.
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

export function renderMarkdown(text: string): HTMLElement {
  const html = marked.parse(text ?? '', { gfm: true, breaks: false, async: false }) as string;
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR],
  });
  const wrapper = document.createElement('div');
  wrapper.className = 'markdown-rendered';
  wrapper.innerHTML = clean;
  return wrapper;
}
