/**
 * List-Renderer tests — Markdown-Checkbox-Pattern.
 */
import { describe, expect, it } from 'vitest';
import { renderList } from './list.js';

describe('renderList', () => {
  it('parses a 3-item checklist with mixed checked/unchecked', () => {
    const text = `# Einkauf
- [ ] Milch
- [x] Brot
- [ ] Käse`;
    const el = renderList(text);
    expect(el.querySelector('h2')?.textContent).toBe('Einkauf');
    const items = el.querySelectorAll('.checkbox-list li');
    expect(items).toHaveLength(3);
    const checks = el.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
    expect(checks).toHaveLength(3);
    expect(checks[0]?.checked).toBe(false);
    expect(checks[1]?.checked).toBe(true);
    expect(checks[2]?.checked).toBe(false);
    // All checkboxes are read-only
    for (const c of Array.from(checks)) {
      expect(c.disabled).toBe(true);
    }
  });

  it('extracts item-tags from `#tag` suffix', () => {
    const el = renderList('- [ ] Banane #obst #lidl');
    const tags = el.querySelectorAll('.tag');
    expect(tags).toHaveLength(2);
    expect(tags[0]?.textContent).toBe('obst');
    expect(tags[1]?.textContent).toBe('lidl');
  });

  it('handles empty input gracefully', () => {
    const el = renderList('');
    expect(el.querySelectorAll('li')).toHaveLength(0);
  });
});
