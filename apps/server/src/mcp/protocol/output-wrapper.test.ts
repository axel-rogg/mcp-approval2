/**
 * Tests for wrapKcUntrusted — IPI-Output-Wrapper.
 *
 * Plan-Ref: PLAN-document-linking.md §10.5 D3.
 */
import { describe, expect, it } from 'vitest';
import { wrapKcUntrusted } from './output-wrapper.js';

const OPEN = '<external-content source="kc:user-content" untrusted="true">';
const CLOSE = '</external-content>';

describe('wrapKcUntrusted', () => {
  it('wraps title and description on a flat object', () => {
    const input = { id: 'abc', title: 'Hello', description: 'World' };
    const out = wrapKcUntrusted(input);
    expect(out).toEqual({
      id: 'abc',
      title: `${OPEN}Hello${CLOSE}`,
      description: `${OPEN}World${CLOSE}`,
    });
  });

  it('wraps body when present', () => {
    const out = wrapKcUntrusted({ body: '# Markdown content', id: 'x' });
    expect(out).toEqual({ body: `${OPEN}# Markdown content${CLOSE}`, id: 'x' });
  });

  it('wraps summary when present (alias of description in ref-views)', () => {
    const out = wrapKcUntrusted({ summary: 'Brief note' });
    expect(out).toEqual({ summary: `${OPEN}Brief note${CLOSE}` });
  });

  it('leaves non-User-Content fields untouched', () => {
    const out = wrapKcUntrusted({
      id: 'abc',
      role: 'resource',
      subtype: 'doc',
      score: 0.87,
      uri: 'kc://object/abc',
      created_at: 1700000000,
    });
    expect(out).toEqual({
      id: 'abc',
      role: 'resource',
      subtype: 'doc',
      score: 0.87,
      uri: 'kc://object/abc',
      created_at: 1700000000,
    });
  });

  it('walks nested arrays of objects', () => {
    const input = {
      items: [
        { id: '1', title: 'First' },
        { id: '2', title: 'Second' },
      ],
    };
    const out = wrapKcUntrusted(input);
    expect(out).toEqual({
      items: [
        { id: '1', title: `${OPEN}First${CLOSE}` },
        { id: '2', title: `${OPEN}Second${CLOSE}` },
      ],
    });
  });

  it('walks refs structure (planned PLAN §3.2 shape)', () => {
    const input = {
      id: 'skill-1',
      title: 'PDF-Handling',
      description: 'Skill for PDF ops',
      refs: {
        outgoing: [
          { id: 'doc-a', role: 'resource', title: 'API-Reference', summary: 'pdfplumber API', uri: 'kc://object/doc-a' },
          { id: 'doc-b', role: 'references', title: 'Recipe X', summary: 'how to use', uri: 'kc://object/doc-b' },
        ],
        incoming: [],
        truncated: { outgoing: false, incoming: false },
      },
    };
    const out = wrapKcUntrusted(input) as typeof input;
    expect(out.title).toBe(`${OPEN}PDF-Handling${CLOSE}`);
    expect(out.description).toBe(`${OPEN}Skill for PDF ops${CLOSE}`);
    expect(out.refs.outgoing[0]!.title).toBe(`${OPEN}API-Reference${CLOSE}`);
    expect(out.refs.outgoing[0]!.summary).toBe(`${OPEN}pdfplumber API${CLOSE}`);
    expect(out.refs.outgoing[0]!.role).toBe('resource');
    expect(out.refs.outgoing[0]!.uri).toBe('kc://object/doc-a');
  });

  it('is idempotent — does not double-wrap already-wrapped strings', () => {
    const wrapped = `${OPEN}already wrapped${CLOSE}`;
    const out = wrapKcUntrusted({ title: wrapped });
    expect(out).toEqual({ title: wrapped });
  });

  it('preserves null/undefined fields', () => {
    const out = wrapKcUntrusted({ title: null, description: undefined, id: 'x' });
    expect(out).toEqual({ title: null, description: undefined, id: 'x' });
  });

  it('does not wrap empty strings', () => {
    const out = wrapKcUntrusted({ title: '' });
    expect(out).toEqual({ title: '' });
  });

  it('passes through primitives and null at root', () => {
    expect(wrapKcUntrusted('a string')).toBe('a string');
    expect(wrapKcUntrusted(42)).toBe(42);
    expect(wrapKcUntrusted(null)).toBe(null);
    expect(wrapKcUntrusted(undefined)).toBe(undefined);
    expect(wrapKcUntrusted(true)).toBe(true);
  });

  it('does not mutate input', () => {
    const input = { title: 'Hello', refs: { outgoing: [{ title: 'inner' }] } };
    const snapshot = JSON.parse(JSON.stringify(input));
    wrapKcUntrusted(input);
    expect(input).toEqual(snapshot);
  });

  it('wraps array of KnowledgeObjects (objects.list shape)', () => {
    const input = {
      items: [
        { id: '1', title: 'a', description: 'd1' },
        { id: '2', title: 'b', description: 'd2' },
      ],
      total: 2,
    };
    const out = wrapKcUntrusted(input) as typeof input;
    expect(out.items[0]!.title).toBe(`${OPEN}a${CLOSE}`);
    expect(out.items[1]!.description).toBe(`${OPEN}d2${CLOSE}`);
    expect(out.total).toBe(2);
  });

  it('walks search-hit used_by[] (PLAN §3.2 shape)', () => {
    const input = {
      hits: [
        {
          id: 'x',
          title: 'Match',
          score: 0.8,
          used_by: [{ id: 'p', role: 'resource', title: 'Parent', summary: 'parent summary' }],
        },
      ],
    };
    const out = wrapKcUntrusted(input) as typeof input;
    expect(out.hits[0]!.title).toBe(`${OPEN}Match${CLOSE}`);
    expect(out.hits[0]!.used_by[0]!.title).toBe(`${OPEN}Parent${CLOSE}`);
    expect(out.hits[0]!.used_by[0]!.summary).toBe(`${OPEN}parent summary${CLOSE}`);
  });
});
