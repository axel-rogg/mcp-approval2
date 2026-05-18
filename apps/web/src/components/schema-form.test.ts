/**
 * Tests fuer schema-form.ts (PLAN-tool-defaults-v2.md Phase B).
 *
 * Scope:
 *   - extractFieldsFromSchema: top-level properties + required-Flag
 *   - pickWidget: korrekte Widget-Auswahl je JSON-Schema-Shape
 *   - renderWidget: getValue/setValue-Roundtrip + validate-Pfade
 */
import { describe, expect, it } from 'vitest';
import {
  extractFieldsFromSchema,
  pickWidget,
  renderWidget,
} from './schema-form.js';

describe('extractFieldsFromSchema', () => {
  it('returns [] for null/empty schemas', () => {
    expect(extractFieldsFromSchema(null)).toEqual([]);
    expect(extractFieldsFromSchema(undefined)).toEqual([]);
    expect(extractFieldsFromSchema({})).toEqual([]);
  });

  it('lists top-level properties with required-Flag', () => {
    const schema = {
      type: 'object',
      properties: {
        max_results: { type: 'integer', minimum: 1 },
        time_zone: { type: 'string' },
        notify: { type: 'boolean' },
      },
      required: ['max_results'],
    };
    const fields = extractFieldsFromSchema(schema);
    expect(fields).toHaveLength(3);
    const map = new Map(fields.map((f) => [f.name, f]));
    expect(map.get('max_results')?.required).toBe(true);
    expect(map.get('time_zone')?.required).toBe(false);
    expect(map.get('notify')?.required).toBe(false);
  });

  it('sorts fields alphabetically', () => {
    const fields = extractFieldsFromSchema({
      properties: { zebra: { type: 'string' }, alpha: { type: 'string' } },
    });
    expect(fields.map((f) => f.name)).toEqual(['alpha', 'zebra']);
  });
});

describe('pickWidget', () => {
  it('picks enum widget when enum present (regardless of type)', () => {
    const spec = pickWidget({ type: 'string', enum: ['a', 'b', 'c'] });
    expect(spec.kind).toBe('enum');
    expect(spec.valueKind).toBe('enum');
  });

  it('picks bool widget for boolean type', () => {
    expect(pickWidget({ type: 'boolean' }).kind).toBe('bool');
  });

  it('picks number widget for integer + number types', () => {
    expect(pickWidget({ type: 'integer' }).kind).toBe('number');
    expect(pickWidget({ type: 'number' }).kind).toBe('number');
    expect(pickWidget({ type: 'integer' }).valueKind).toBe('number');
  });

  it('picks text widget for string type', () => {
    expect(pickWidget({ type: 'string' }).kind).toBe('text');
  });

  it('picks json widget fallback for object/array/unknown', () => {
    expect(pickWidget({ type: 'object' }).kind).toBe('json');
    expect(pickWidget({ type: 'array' }).kind).toBe('json');
    expect(pickWidget({}).kind).toBe('json');
  });

  it('handles array-of-types (picks first non-null)', () => {
    expect(pickWidget({ type: ['string', 'null'] }).kind).toBe('text');
    expect(pickWidget({ type: ['null', 'number'] }).kind).toBe('number');
  });
});

describe('renderWidget — text', () => {
  it('getValue returns the typed value, setValue roundtrips', () => {
    const h = renderWidget({ kind: 'text', valueKind: 'text', schema: { type: 'string' } });
    h.setValue('hello');
    expect(h.getValue()).toBe('hello');
    expect(h.validate()).toBeNull();
  });

  it('validate enforces pattern', () => {
    const h = renderWidget({
      kind: 'text',
      valueKind: 'text',
      schema: { type: 'string', pattern: '^[a-z]+$' },
    });
    h.setValue('VALID-NOT');
    expect(h.validate()).not.toBeNull();
    h.setValue('valid');
    expect(h.validate()).toBeNull();
  });
});

describe('renderWidget — number', () => {
  it('getValue returns a finite number', () => {
    const h = renderWidget({
      kind: 'number',
      valueKind: 'number',
      schema: { type: 'integer', minimum: 1, maximum: 100 },
    });
    h.setValue(25);
    expect(h.getValue()).toBe(25);
    expect(h.validate()).toBeNull();
  });

  it('validate enforces min/max', () => {
    const h = renderWidget({
      kind: 'number',
      valueKind: 'number',
      schema: { type: 'integer', minimum: 1, maximum: 100 },
    });
    h.setValue(250);
    expect(h.validate()).toMatch(/max/);
    h.setValue(0);
    expect(h.validate()).toMatch(/min/);
    h.setValue(50);
    expect(h.validate()).toBeNull();
  });

  it('validate rejects non-integer when type=integer', () => {
    const h = renderWidget({
      kind: 'number',
      valueKind: 'number',
      schema: { type: 'integer' },
    });
    // direct DOM-manipulation: setValue stringifies, but we can poke the input
    const input = h.element as HTMLInputElement;
    input.value = '3.14';
    expect(h.validate()).toMatch(/integer/);
  });
});

describe('renderWidget — bool', () => {
  it('roundtrips checked state', () => {
    const h = renderWidget({
      kind: 'bool',
      valueKind: 'boolean',
      schema: { type: 'boolean' },
    });
    h.setValue(true);
    expect(h.getValue()).toBe(true);
    h.setValue(false);
    expect(h.getValue()).toBe(false);
  });
});

describe('renderWidget — enum', () => {
  it('roundtrips selected enum value', () => {
    const h = renderWidget({
      kind: 'enum',
      valueKind: 'enum',
      schema: { enum: ['public', 'private', 'default'] },
    });
    h.setValue('private');
    expect(h.getValue()).toBe('private');
  });

  it('handles non-string enum values', () => {
    const h = renderWidget({
      kind: 'enum',
      valueKind: 'enum',
      schema: { enum: [1, 2, 3] },
    });
    h.setValue(2);
    expect(h.getValue()).toBe(2);
  });
});

describe('renderWidget — json', () => {
  it('roundtrips JSON object', () => {
    const h = renderWidget({ kind: 'json', valueKind: 'json', schema: {} });
    h.setValue({ foo: 1, bar: 'x' });
    expect(h.getValue()).toEqual({ foo: 1, bar: 'x' });
    expect(h.validate()).toBeNull();
  });

  it('accepts empty as null', () => {
    const h = renderWidget({ kind: 'json', valueKind: 'json', schema: {} });
    h.setValue(null);
    expect(h.getValue()).toBeNull();
    expect(h.validate()).toBeNull();
  });

  it('validate rejects invalid JSON', () => {
    const h = renderWidget({ kind: 'json', valueKind: 'json', schema: {} });
    const ta = h.element.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = '{not valid';
    expect(h.validate()).toMatch(/invalid JSON/);
  });
});
