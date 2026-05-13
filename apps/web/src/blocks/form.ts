/**
 * Renderer fuer form block.
 *
 * State: { schema: JSONSchemaObj; uiSchema?: object|null; value: Record<string, unknown> }
 * Actions: setField(field, value), setValue(value), submit(), reset()
 *
 * Minimal JSON-Schema renderer: only object-with-properties of primitive types
 * (string, number, integer, boolean). Enums become <select>. No nested objects.
 */
import type { BlockRenderer, RenderArgs } from './types.js';
import { el, safeString } from './types.js';

interface JsonSchemaProp {
  readonly type?: string | string[];
  readonly enum?: ReadonlyArray<unknown>;
  readonly title?: string;
  readonly description?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

interface FormState {
  readonly schema?: {
    readonly type?: string;
    readonly properties?: Record<string, JsonSchemaProp>;
    readonly required?: ReadonlyArray<string>;
  };
  readonly value?: Record<string, unknown>;
}

function propType(p: JsonSchemaProp): string {
  if (Array.isArray(p.type)) return p.type[0] ?? 'string';
  return p.type ?? 'string';
}

export const formRenderer: BlockRenderer<FormState> = {
  type: 'form',
  render({ state, onAction }: RenderArgs<FormState>) {
    const schema = state.schema ?? {};
    const props = (schema.properties ?? {}) as Record<string, JsonSchemaProp>;
    const required = new Set<string>(schema.required ?? []);
    const value = (state.value ?? {}) as Record<string, unknown>;

    async function dispatch(action: string, payload?: Record<string, unknown>): Promise<void> {
      try {
        await onAction(action, payload);
      } catch (e) {
        console.error('form dispatch', action, e);
      }
    }

    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
    const fields: HTMLElement[] = [];

    for (const [name, prop] of Object.entries(props)) {
      const t = propType(prop);
      const cur = value[name];
      const title = safeString(prop.title, name);
      const isRequired = required.has(name);

      let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      if (prop.enum && Array.isArray(prop.enum)) {
        const sel = el('select') as HTMLSelectElement;
        for (const v of prop.enum) {
          const opt = el('option', { value: String(v), text: String(v) }) as HTMLOptionElement;
          sel.appendChild(opt);
        }
        if (cur !== undefined) sel.value = String(cur);
        input = sel;
      } else if (t === 'boolean') {
        const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
        if (cur === true) cb.checked = true;
        input = cb;
      } else if (t === 'number' || t === 'integer') {
        const inp = el('input', {
          type: 'number',
          ...(t === 'integer' ? { step: 1 } : { step: 'any' }),
          ...(prop.minimum !== undefined ? { min: prop.minimum } : {}),
          ...(prop.maximum !== undefined ? { max: prop.maximum } : {}),
        }) as HTMLInputElement;
        if (typeof cur === 'number') inp.value = String(cur);
        input = inp;
      } else {
        const inp = el('input', {
          type: 'text',
          ...(prop.maxLength !== undefined ? { maxlength: prop.maxLength } : {}),
        }) as HTMLInputElement;
        if (typeof cur === 'string') inp.value = cur;
        input = inp;
      }

      inputs.set(name, input);
      fields.push(
        el('div', { class: 'field block-form-field' }, [
          el('label', { text: title + (isRequired ? ' *' : '') }),
          input,
          prop.description
            ? el('small', { class: 'muted', text: safeString(prop.description, '') })
            : null,
        ]),
      );
    }

    function collect(): Record<string, unknown> {
      const out: Record<string, unknown> = {};
      for (const [name, input] of inputs.entries()) {
        const prop = props[name];
        if (!prop) continue;
        const t = propType(prop);
        if (prop.enum) {
          out[name] = (input as HTMLSelectElement).value;
        } else if (t === 'boolean') {
          out[name] = (input as HTMLInputElement).checked;
        } else if (t === 'number' || t === 'integer') {
          const v = (input as HTMLInputElement).value;
          if (v === '') continue;
          const n = Number(v);
          if (!Number.isNaN(n)) out[name] = t === 'integer' ? Math.trunc(n) : n;
        } else {
          out[name] = (input as HTMLInputElement).value;
        }
      }
      return out;
    }

    const submitBtn = el('button', {
      type: 'button',
      class: 'btn',
      text: 'Submit',
      onclick: async () => {
        submitBtn.disabled = true;
        try {
          await dispatch('setValue', { value: collect() });
          await dispatch('submit', {});
        } finally {
          submitBtn.disabled = false;
        }
      },
    });

    const resetBtn = el('button', {
      type: 'button',
      class: 'btn btn-secondary',
      text: 'Reset',
      onclick: () => void dispatch('reset', {}),
    });

    return el('div', { class: 'block block-form' }, [
      el('div', { class: 'form' }, fields),
      el('div', { class: 'row block-form-actions' }, [submitBtn, resetBtn]),
    ]);
  },
};
