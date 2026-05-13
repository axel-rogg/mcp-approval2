/**
 * Form-Block — strukturiertes Daten-Eingabe-Feld (JSON-Schema-getrieben).
 */
import type { BlockDef, BlockActionDef, BlockQueryDef } from './types.js';

export interface FormState {
  schema: Record<string, unknown>;
  uiSchema?: Record<string, unknown> | null;
  value: Record<string, unknown>;
}

const setField: BlockActionDef<FormState, { field: string; value: unknown }> = {
  name: 'setField',
  description: 'Set a single top-level field in the form value (shallow merge).',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['field', 'value'],
    properties: {
      field: { type: 'string', minLength: 1, maxLength: 200 },
      value: {},
    },
  },
  sensitivity: 'approval',
  approval_display_template: 'Form → set {{payload.field}} = {{payload.value}}',
  handler: (_state, payload) => ({
    patches: [{ path: `/value/${payload.field}`, value: payload.value }],
  }),
};

const setValue: BlockActionDef<FormState, { value: Record<string, unknown> }> = {
  name: 'setValue',
  description: 'Replace the full form value (object).',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['value'],
    properties: { value: { type: 'object' } },
  },
  sensitivity: 'approval',
  approval_display_template: 'Form → set value to {{payload.value}}',
  handler: (_state, payload) => ({
    patches: [{ path: '/value', value: payload.value }],
  }),
};

const submit: BlockActionDef<FormState, { value?: Record<string, unknown> }> = {
  name: 'submit',
  description: 'Fire form-submit. Optional `value` overrides current state.value.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    properties: { value: { type: 'object' } },
  },
  sensitivity: 'approval',
  approval_display_template: 'Form → submit',
  handler: (state, payload) => {
    const finalValue = payload.value ?? state.value;
    return {
      patches: payload.value ? [{ path: '/value', value: payload.value }] : [],
      result: {
        submitted: true,
        value: finalValue,
        submitted_at: new Date().toISOString(),
      },
    };
  },
};

const reset: BlockActionDef<FormState, Record<string, never>> = {
  name: 'reset',
  description: 'Clear the form value.',
  payload_schema: { type: 'object', additionalProperties: false },
  sensitivity: 'approval',
  approval_display_template: 'Form → reset',
  handler: () => ({ patches: [{ path: '/value', value: {} }] }),
};

const valueQuery: BlockQueryDef<FormState, Record<string, never>, Record<string, unknown>> = {
  name: 'value',
  description: 'Returns the current form value object.',
  returns_schema: { type: 'object' },
  compute: (state) => state.value,
};

const schemaQuery: BlockQueryDef<FormState, Record<string, never>, Record<string, unknown>> = {
  name: 'schema',
  description: 'Returns the configured JSON-Schema.',
  returns_schema: { type: 'object' },
  compute: (state) => state.schema,
};

const isEmptyQuery: BlockQueryDef<FormState, Record<string, never>, boolean> = {
  name: 'isEmpty',
  description: 'Returns true if the form value has no fields set.',
  returns_schema: { type: 'boolean' },
  compute: (state) => Object.keys(state.value ?? {}).length === 0,
};

export const formBlock: BlockDef<FormState> = {
  type: 'form',
  description: 'Schema-driven structured form.',
  state_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'value'],
    properties: {
      schema: { type: 'object' },
      uiSchema: { type: ['object', 'null'] },
      value: { type: 'object' },
    },
  },
  initial_state: () => ({
    schema: { type: 'object', properties: {} },
    uiSchema: null,
    value: {},
  }),
  validate: (state) => {
    if (!state.schema || typeof state.schema !== 'object') {
      throw new Error('form.schema must be an object (JSON-Schema)');
    }
    if (state.uiSchema != null && typeof state.uiSchema !== 'object') {
      throw new Error('form.uiSchema must be object or null');
    }
    if (!state.value || typeof state.value !== 'object' || Array.isArray(state.value)) {
      throw new Error('form.value must be a plain object');
    }
  },
  actions: { setField, setValue, submit, reset },
  queries: { value: valueQuery, schema: schemaQuery, isEmpty: isEmptyQuery },
  a2ui_component: 'Form',
};
