/**
 * TextField-Block — Free-Text Input, single-line oder multiline.
 */
import type { BlockDef, BlockActionDef, BlockQueryDef } from './types.js';

export interface TextFieldState {
  value: string;
  placeholder?: string | null;
  multiline?: boolean;
  maxLength?: number | null;
}

const setValue: BlockActionDef<TextFieldState, { value: string }> = {
  name: 'setValue',
  description: 'Set the text-field value.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['value'],
    properties: { value: { type: 'string' } },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'TextField → set value to "{{payload.value}}"',
  handler: (state, payload) => {
    const max = state.maxLength ?? null;
    if (max !== null && payload.value.length > max) {
      throw new Error(`text-field max ${max} chars (got ${payload.value.length})`);
    }
    return { patches: [{ path: '/value', value: payload.value }] };
  },
};

const valueQuery: BlockQueryDef<TextFieldState, Record<string, never>, string> = {
  name: 'value',
  description: 'Returns the current text-field value.',
  returns_schema: { type: 'string' },
  compute: (state) => state.value,
};

const lengthQuery: BlockQueryDef<TextFieldState, Record<string, never>, number> = {
  name: 'length',
  description: 'Returns the character-length of the current value.',
  returns_schema: { type: 'integer', minimum: 0 },
  compute: (state) => state.value.length,
};

const isEmptyQuery: BlockQueryDef<TextFieldState, Record<string, never>, boolean> = {
  name: 'isEmpty',
  description: 'Returns true if the value is the empty string.',
  returns_schema: { type: 'boolean' },
  compute: (state) => state.value === '',
};

export const textFieldBlock: BlockDef<TextFieldState> = {
  type: 'text_field',
  description: 'A free-text input field, single-line by default.',
  state_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['value'],
    properties: {
      value: { type: 'string' },
      placeholder: { type: ['string', 'null'], maxLength: 200 },
      multiline: { type: 'boolean' },
      maxLength: { type: ['integer', 'null'], minimum: 1, maximum: 65536 },
    },
  },
  initial_state: () => ({ value: '', placeholder: null, multiline: false, maxLength: null }),
  validate: (state) => {
    if (typeof state.value !== 'string') {
      throw new Error('text_field.value must be a string');
    }
    if (state.maxLength != null && state.value.length > state.maxLength) {
      throw new Error(`text_field.value exceeds maxLength ${state.maxLength}`);
    }
  },
  actions: { setValue },
  queries: { value: valueQuery, length: lengthQuery, isEmpty: isEmptyQuery },
  a2ui_component: 'TextField',
};
