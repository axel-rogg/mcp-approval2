/**
 * Counter-Block — numerischer Zaehler mit optional target + lastReset.
 */
import type { BlockDef, BlockActionDef, BlockQueryDef } from './types.js';

const MIN_VALUE = -1_000_000_000;
const MAX_VALUE = 1_000_000_000;

export interface CounterState {
  value: number;
  target?: number | null;
  lastReset?: number | null;
}

const increment: BlockActionDef<CounterState, { by?: number }> = {
  name: 'increment',
  description: 'Increase the counter by `by` (default 1).',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    properties: { by: { type: 'integer', minimum: 1, maximum: 1_000_000 } },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Counter → +{{payload.by}} (was {{current_state.value}})',
  handler: (state, payload) => {
    const by = payload.by ?? 1;
    const next = state.value + by;
    if (next > MAX_VALUE) {
      throw new Error(`counter overflow: ${state.value} + ${by} > ${MAX_VALUE}`);
    }
    return { patches: [{ path: '/value', value: next }] };
  },
};

const decrement: BlockActionDef<CounterState, { by?: number }> = {
  name: 'decrement',
  description: 'Decrease the counter by `by` (default 1).',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    properties: { by: { type: 'integer', minimum: 1, maximum: 1_000_000 } },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Counter → -{{payload.by}} (was {{current_state.value}})',
  handler: (state, payload) => {
    const by = payload.by ?? 1;
    const next = state.value - by;
    if (next < MIN_VALUE) {
      throw new Error(`counter underflow: ${state.value} - ${by} < ${MIN_VALUE}`);
    }
    return { patches: [{ path: '/value', value: next }] };
  },
};

const setValue: BlockActionDef<CounterState, { value: number }> = {
  name: 'setValue',
  description: 'Set the counter to a specific value.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['value'],
    properties: { value: { type: 'integer', minimum: MIN_VALUE, maximum: MAX_VALUE } },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Counter → set to {{payload.value}} (was {{current_state.value}})',
  handler: (_state, payload) => ({ patches: [{ path: '/value', value: payload.value }] }),
};

const reset: BlockActionDef<CounterState, Record<string, never>> = {
  name: 'reset',
  description: 'Reset the counter to 0 and stamp lastReset.',
  payload_schema: { type: 'object', additionalProperties: false },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Counter → reset to 0 (was {{current_state.value}})',
  handler: () => ({
    patches: [
      { path: '/value', value: 0 },
      { path: '/lastReset', value: Date.now() },
    ],
  }),
};

const valueQuery: BlockQueryDef<CounterState, Record<string, never>, number> = {
  name: 'value',
  description: 'Returns the current counter value.',
  returns_schema: { type: 'integer' },
  compute: (state) => state.value,
};

const progressRatioQuery: BlockQueryDef<CounterState, Record<string, never>, number | null> = {
  name: 'progressRatio',
  description: 'Returns value/target clamped to [0, 1], or null if target is not set.',
  returns_schema: { type: ['number', 'null'], minimum: 0, maximum: 1 },
  compute: (state) => {
    if (state.target == null || state.target <= 0) return null;
    const ratio = state.value / state.target;
    return Math.max(0, Math.min(1, ratio));
  },
};

const lastResetQuery: BlockQueryDef<CounterState, Record<string, never>, number | null> = {
  name: 'lastReset',
  description: 'Returns the unix-ms timestamp of the last reset, or null if never reset.',
  returns_schema: { type: ['integer', 'null'] },
  compute: (state) => state.lastReset ?? null,
};

export const counterBlock: BlockDef<CounterState> = {
  type: 'counter',
  description: 'Numeric counter with optional target + lastReset stamp.',
  state_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['value'],
    properties: {
      value: { type: 'integer', minimum: MIN_VALUE, maximum: MAX_VALUE },
      target: { type: ['integer', 'null'], minimum: 1, maximum: MAX_VALUE },
      lastReset: { type: ['integer', 'null'], minimum: 0 },
    },
  },
  initial_state: () => ({ value: 0, target: null, lastReset: null }),
  validate: (state) => {
    if (typeof state.value !== 'number' || !Number.isInteger(state.value)) {
      throw new Error('counter.value must be an integer');
    }
    if (state.value < MIN_VALUE || state.value > MAX_VALUE) {
      throw new Error(`counter.value out of range [${MIN_VALUE}, ${MAX_VALUE}]`);
    }
    if (state.target != null) {
      if (typeof state.target !== 'number' || !Number.isInteger(state.target) || state.target <= 0) {
        throw new Error('counter.target must be a positive integer if set');
      }
    }
  },
  actions: { increment, decrement, setValue, reset },
  queries: { value: valueQuery, progressRatio: progressRatioQuery, lastReset: lastResetQuery },
  a2ui_component: 'Counter',
};
