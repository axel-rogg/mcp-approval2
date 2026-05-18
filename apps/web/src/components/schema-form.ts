/**
 * Schema-Form-Widget-Library — typed Eingabe-Felder aus JSON-Schema.
 *
 * Plan-Ref: docs/plans/active/PLAN-tool-defaults-v2.md (Phase B).
 *
 * Verantwortung:
 *   - `extractFieldsFromSchema(schema)` listet top-level Properties eines
 *     JSON-Schemas (aus tools/list._meta.inputSchema oder Inventory).
 *   - `pickWidget(propSchema)` waehlt das richtige Widget je nach JSON-
 *     Schema-Shape (`type`, `enum`, `format`).
 *   - `renderWidget(widgetSpec, container)` rendert das Widget in `container`
 *     und returnt `{getValue, validate, valueKind}` zum Schreiben.
 *
 * Widgets in dieser Phase:
 *   - text   — `<input type="text">` (mit optional `pattern` + `maxLength`)
 *   - number — `<input type="number">` (mit `min`/`max`/`step`)
 *   - bool   — `<input type="checkbox">` Toggle
 *   - enum   — `<select>` aus enum-Werten
 *   - json   — `<textarea>` mit JSON.parse-Validation (Fallback fuer object/array)
 *
 * Pure DOM, kein Framework — entspricht v2-PWA-Konvention.
 */

export type WidgetKind = 'text' | 'number' | 'bool' | 'enum' | 'json';

/** Korrespondiert mit ToolDefaultValueKind im Backend. */
export type ValueKind = 'text' | 'number' | 'boolean' | 'enum' | 'json';

export interface SchemaField {
  readonly name: string;
  readonly required: boolean;
  readonly schema: PropertySchema;
}

export interface PropertySchema {
  readonly type?: string | ReadonlyArray<string>;
  readonly enum?: ReadonlyArray<unknown>;
  readonly format?: string;
  readonly description?: string;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly default?: unknown;
  readonly title?: string;
  readonly [extra: string]: unknown;
}

export interface WidgetSpec {
  readonly kind: WidgetKind;
  readonly valueKind: ValueKind;
  readonly schema: PropertySchema;
}

export interface WidgetHandle {
  readonly element: HTMLElement;
  /** Returnt den typed Value oder wirft bei Invalidem Input. */
  getValue(): unknown;
  /** Setzt den initialen Wert. */
  setValue(v: unknown): void;
  /** Validiert; returnt null wenn ok, sonst Fehlertext. */
  validate(): string | null;
  readonly valueKind: ValueKind;
}

// ---------------------------------------------------------------------------
// Schema-Inspection
// ---------------------------------------------------------------------------

/**
 * Extrahiert top-level `properties` eines JSON-Schemas. Akzeptiert sowohl
 * `{type: 'object', properties: {...}, required: [...]}` als auch flat
 * `{properties: {...}}` (Zod-zu-JSON-Schema-Variante).
 *
 * Returnt `[]` wenn das Schema nichts useful enthaelt.
 */
export function extractFieldsFromSchema(
  schema: Record<string, unknown> | null | undefined,
): SchemaField[] {
  if (!schema || typeof schema !== 'object') return [];
  const props = schema['properties'] as Record<string, unknown> | undefined;
  if (!props || typeof props !== 'object') return [];
  const required = new Set<string>(
    Array.isArray(schema['required'])
      ? (schema['required'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
  );
  const out: SchemaField[] = [];
  for (const [name, raw] of Object.entries(props)) {
    if (!raw || typeof raw !== 'object') continue;
    out.push({
      name,
      required: required.has(name),
      schema: raw as PropertySchema,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Widget-Auswahl
// ---------------------------------------------------------------------------

export function pickWidget(prop: PropertySchema): WidgetSpec {
  if (prop.enum && Array.isArray(prop.enum) && prop.enum.length > 0) {
    return { kind: 'enum', valueKind: 'enum', schema: prop };
  }
  const t = normalizeType(prop.type);
  if (t === 'boolean') {
    return { kind: 'bool', valueKind: 'boolean', schema: prop };
  }
  if (t === 'integer' || t === 'number') {
    return { kind: 'number', valueKind: 'number', schema: prop };
  }
  if (t === 'string') {
    return { kind: 'text', valueKind: 'text', schema: prop };
  }
  // object / array / null / unknown → JSON-Editor-Fallback
  return { kind: 'json', valueKind: 'json', schema: prop };
}

function normalizeType(t: unknown): string | undefined {
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) {
    // Multi-Type JSON-Schemas wie ['string','null'] → ersten Nicht-null-Typ wählen.
    for (const v of t) {
      if (typeof v === 'string' && v !== 'null') return v;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Widget-Rendering
// ---------------------------------------------------------------------------

export function renderWidget(spec: WidgetSpec): WidgetHandle {
  switch (spec.kind) {
    case 'text':
      return renderText(spec);
    case 'number':
      return renderNumber(spec);
    case 'bool':
      return renderBool(spec);
    case 'enum':
      return renderEnum(spec);
    case 'json':
      return renderJson(spec);
  }
}

function renderText(spec: WidgetSpec): WidgetHandle {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'schema-widget schema-widget-text';
  if (typeof spec.schema.maxLength === 'number') {
    input.maxLength = spec.schema.maxLength;
  }
  if (typeof spec.schema.pattern === 'string') {
    input.pattern = spec.schema.pattern;
  }
  if (typeof spec.schema.default === 'string') {
    input.placeholder = spec.schema.default;
  }
  return {
    element: input,
    valueKind: 'text',
    getValue: () => input.value,
    setValue: (v) => {
      input.value = typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
    },
    validate: () => {
      if (typeof spec.schema.minLength === 'number' && input.value.length < spec.schema.minLength) {
        return `min length ${spec.schema.minLength}`;
      }
      if (spec.schema.pattern && !new RegExp(spec.schema.pattern).test(input.value)) {
        return `does not match pattern ${spec.schema.pattern}`;
      }
      return null;
    },
  };
}

function renderNumber(spec: WidgetSpec): WidgetHandle {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'schema-widget schema-widget-number';
  if (typeof spec.schema.minimum === 'number') input.min = String(spec.schema.minimum);
  if (typeof spec.schema.maximum === 'number') input.max = String(spec.schema.maximum);
  // integer → step=1, ansonsten step="any".
  const type = normalizeType(spec.schema.type);
  input.step = type === 'integer' ? '1' : 'any';
  if (typeof spec.schema.default === 'number') {
    input.placeholder = String(spec.schema.default);
  }
  return {
    element: input,
    valueKind: 'number',
    getValue: () => {
      const n = Number.parseFloat(input.value);
      return Number.isFinite(n) ? n : Number.NaN;
    },
    setValue: (v) => {
      input.value = typeof v === 'number' ? String(v) : '';
    },
    validate: () => {
      if (input.value === '') return 'value required';
      const n = Number.parseFloat(input.value);
      if (!Number.isFinite(n)) return 'not a finite number';
      if (typeof spec.schema.minimum === 'number' && n < spec.schema.minimum) {
        return `min ${spec.schema.minimum}`;
      }
      if (typeof spec.schema.maximum === 'number' && n > spec.schema.maximum) {
        return `max ${spec.schema.maximum}`;
      }
      if (normalizeType(spec.schema.type) === 'integer' && !Number.isInteger(n)) {
        return 'must be integer';
      }
      return null;
    },
  };
}

function renderBool(spec: WidgetSpec): WidgetHandle {
  const wrap = document.createElement('label');
  wrap.className = 'schema-widget schema-widget-bool';
  const input = document.createElement('input');
  input.type = 'checkbox';
  wrap.appendChild(input);
  const label = document.createElement('span');
  label.className = 'muted small';
  label.textContent = ' (true / false)';
  wrap.appendChild(label);
  return {
    element: wrap,
    valueKind: 'boolean',
    getValue: () => input.checked,
    setValue: (v) => {
      input.checked = v === true;
    },
    validate: () => null,
    // Suppress unused-variable warning ohne den schema-Arg zu droppen — bewusst.
    // @ts-expect-error: schema in closure, not referenced in body.
    _: spec,
  };
}

function renderEnum(spec: WidgetSpec): WidgetHandle {
  const select = document.createElement('select');
  select.className = 'schema-widget schema-widget-enum';
  const opts = Array.isArray(spec.schema.enum) ? spec.schema.enum : [];
  for (const v of opts) {
    const opt = document.createElement('option');
    opt.value = JSON.stringify(v);
    opt.textContent = formatEnumLabel(v);
    select.appendChild(opt);
  }
  return {
    element: select,
    valueKind: 'enum',
    getValue: () => {
      try {
        return JSON.parse(select.value) as unknown;
      } catch {
        return select.value;
      }
    },
    setValue: (v) => {
      try {
        select.value = JSON.stringify(v);
      } catch {
        // ignore
      }
    },
    validate: () => (select.value === '' ? 'select a value' : null),
  };
}

function formatEnumLabel(v: unknown): string {
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function renderJson(spec: WidgetSpec): WidgetHandle {
  const wrap = document.createElement('div');
  wrap.className = 'schema-widget schema-widget-json';
  const ta = document.createElement('textarea');
  ta.rows = 3;
  ta.spellcheck = false;
  ta.placeholder = '{"foo": 1}  oder  ["a", "b"]';
  wrap.appendChild(ta);
  const hint = document.createElement('div');
  hint.className = 'muted small';
  hint.textContent = 'JSON-Wert (Objekt, Array, null, …)';
  wrap.appendChild(hint);
  return {
    element: wrap,
    valueKind: 'json',
    getValue: () => {
      const s = ta.value.trim();
      if (s === '') return null;
      return JSON.parse(s) as unknown;
    },
    setValue: (v) => {
      ta.value = v === null || v === undefined ? '' : JSON.stringify(v, null, 2);
    },
    validate: () => {
      const s = ta.value.trim();
      if (s === '') return null;
      try {
        JSON.parse(s);
      } catch (e) {
        return `invalid JSON: ${(e as Error).message}`;
      }
      return null;
    },
    // @ts-expect-error: schema referenced upstream
    _: spec,
  };
}
