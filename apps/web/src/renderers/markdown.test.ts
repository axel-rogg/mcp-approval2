/**
 * Markdown-Renderer smoke + XSS-Sanitization tests.
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown.js';

describe('renderMarkdown', () => {
  it('renders headings + lists into HTML', () => {
    const el = renderMarkdown('# Hello\n\n- one\n- two');
    expect(el.tagName).toBe('DIV');
    expect(el.className).toBe('markdown-rendered');
    expect(el.querySelector('h1')?.textContent).toBe('Hello');
    expect(el.querySelectorAll('li')).toHaveLength(2);
  });

  it('strips <script> tags (DOMPurify sanitization)', () => {
    const el = renderMarkdown('hello\n\n<script>alert("xss")</script>\n\nworld');
    expect(el.querySelector('script')).toBeNull();
    expect(el.innerHTML).not.toContain('alert');
  });

  it('strips event-handler attributes like onerror', () => {
    const el = renderMarkdown('<img src=x onerror="alert(1)">');
    // `img` is not in ALLOWED_TAGS so it'd be stripped entirely; onerror cannot survive
    expect(el.innerHTML).not.toContain('onerror');
    expect(el.innerHTML).not.toContain('alert');
  });

  it('preserves safe links with href', () => {
    const el = renderMarkdown('[link](https://example.com)');
    const a = el.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.com');
  });

  it('handles empty input', () => {
    const el = renderMarkdown('');
    expect(el.className).toBe('markdown-rendered');
    expect(el.innerHTML.trim()).toBe('');
  });

  // ─── PLAN-document-linking §10.5 D1 + P8: kc:// URI-Resolver ─────────
  it('rewrites kc://object/<uuid> to #/storage/<uuid>', () => {
    const el = renderMarkdown(
      '[API-Ref](kc://object/01234567-89ab-cdef-0123-456789abcdef)',
    );
    const a = el.querySelector('a');
    expect(a?.getAttribute('href')).toBe(
      '#/storage/01234567-89ab-cdef-0123-456789abcdef',
    );
    expect(a?.classList.contains('kc-link')).toBe(true);
  });

  it('rewrites kc://object/<uuid>#<anchor> to #/storage/<uuid>#<anchor>', () => {
    const el = renderMarkdown(
      '[Section](kc://object/01234567-89ab-cdef-0123-456789abcdef#section-2)',
    );
    const a = el.querySelector('a');
    expect(a?.getAttribute('href')).toBe(
      '#/storage/01234567-89ab-cdef-0123-456789abcdef#section-2',
    );
  });

  it('strips javascript: URIs even via kc-allowlist (defense-in-depth)', () => {
    const el = renderMarkdown('[evil](javascript:alert(1))');
    const a = el.querySelector('a');
    // DOMPurify ALLOWED_URI_REGEXP no longer matches javascript: → strip
    expect(a?.getAttribute('href')).toBeFalsy();
  });

  it('strips data: URIs', () => {
    const el = renderMarkdown('[evil](data:text/html,<script>alert(1)</script>)');
    const a = el.querySelector('a');
    expect(a?.getAttribute('href')).toBeFalsy();
  });

  it('preserves https: URIs (still allowed)', () => {
    const el = renderMarkdown('[ok](https://example.com)');
    const a = el.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.com');
  });

  it('does not rewrite malformed kc:// URIs (bad uuid format)', () => {
    // Bad uuid → no match in KC_URI_REGEX → leave href as-is (which DOMPurify
    // already vetted; in this case the strict ALLOWED_URI_REGEXP would also
    // have stripped it because the form is broken).
    const el = renderMarkdown('[bad](kc://object/garbage)');
    const a = el.querySelector('a');
    // Either stripped by DOMPurify (likely) or untouched. Not rewritten:
    expect(a?.getAttribute('href')).not.toBe('#/storage/garbage');
  });
});
