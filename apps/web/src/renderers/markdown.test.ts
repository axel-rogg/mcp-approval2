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
});
