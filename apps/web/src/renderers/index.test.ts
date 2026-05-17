/**
 * Renderer-Dispatch tests — verify each subtype hits the correct renderer.
 */
import { describe, expect, it } from 'vitest';
import type { KnowledgeObject } from '../api-storage.js';
import { dispatchRenderer } from './index.js';

function makeObj(partial: Partial<KnowledgeObject>): KnowledgeObject {
  return {
    id: 'obj_test',
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  } as KnowledgeObject;
}

describe('dispatchRenderer', () => {
  it('routes subtype=doc (markdown) to markdown renderer', () => {
    const el = dispatchRenderer(
      makeObj({
        subtype: 'doc',
        contentType: 'text/markdown',
        body: '# Hi',
        bodyEncoding: 'utf8',
      }),
    );
    expect(el.className).toContain('markdown-rendered');
    expect(el.querySelector('h1')?.textContent).toBe('Hi');
  });

  it('routes subtype=note to markdown renderer', () => {
    const el = dispatchRenderer(
      makeObj({
        subtype: 'note',
        body: '## Section',
        bodyEncoding: 'utf8',
      }),
    );
    expect(el.className).toContain('markdown-rendered');
    expect(el.querySelector('h2')?.textContent).toBe('Section');
  });

  it('routes subtype=list to checkbox-list renderer', () => {
    const el = dispatchRenderer(
      makeObj({
        subtype: 'list',
        body: '- [x] done\n- [ ] todo',
        bodyEncoding: 'utf8',
      }),
    );
    expect(el.className).toBe('checkbox-list-wrapper');
    expect(el.querySelectorAll('input[type=checkbox]')).toHaveLength(2);
  });

  it('routes subtype=memo to memo renderer with scope-tag from metaJson', () => {
    const el = dispatchRenderer(
      makeObj({
        subtype: 'memo',
        body: 'Axel mag Espresso',
        bodyEncoding: 'utf8',
        metaJson: { scope: 'personal' },
      }),
    );
    expect(el.className).toBe('memo-card');
    expect(el.querySelector('.scope-tag')?.textContent).toContain('personal');
  });

  it('routes subtype=skill_manifest to skill-manifest renderer', () => {
    const text = '---\nslug: my-skill\nversion: 1.0.0\n---\n\n# Body';
    const el = dispatchRenderer(
      makeObj({ subtype: 'skill_manifest', body: text, bodyEncoding: 'utf8' }),
    );
    expect(el.className).toBe('skill-manifest-rendered');
    expect(el.querySelector('.skill-manifest-frontmatter')).not.toBeNull();
    expect(el.querySelector('h1')?.textContent).toBe('Body');
  });

  it('routes app:* subtype to app-link renderer', () => {
    const el = dispatchRenderer(
      makeObj({
        id: 'obj_app1',
        subtype: 'app:composable',
        body: '{}',
        bodyEncoding: 'utf8',
      }),
    );
    expect(el.className).toBe('app-link-card');
    const link = el.querySelector('a');
    expect(link?.getAttribute('href')).toBe('#/apps/obj_app1');
  });

  it('routes subtype=doc with image/* contentType to binary renderer', () => {
    const el = dispatchRenderer(
      makeObj({
        subtype: 'doc',
        contentType: 'image/png',
        body: 'aGVsbG8=', // "hello" base64
        bodyEncoding: 'base64',
      }),
    );
    expect(el.className).toBe('binary-renderer');
    expect(el.querySelector('img')).not.toBeNull();
  });

  it('falls back to code-renderer for unknown subtypes (2026-05-17 unified)', () => {
    const el = dispatchRenderer(
      makeObj({ subtype: 'weird-thing', body: 'raw', bodyEncoding: 'utf8' }),
    );
    // After unified-body refactor, unknown subtypes route to renderCode
    // (hljs autodetect) wrapped in <div class="body-content code-rendered">.
    expect(el.className).toContain('code-rendered');
    expect(el.querySelector('pre code')?.textContent).toContain('raw');
  });
});
