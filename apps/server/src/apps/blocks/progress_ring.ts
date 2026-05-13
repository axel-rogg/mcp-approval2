/**
 * Progress-Ring-Block — radiales Gauge mit value/target.
 */
import type { BlockDef, BlockActionDef, BlockQueryDef } from './types.js';

const MIN_VALUE = 0;
const MAX_VALUE = 1_000_000_000;

export interface ProgressRingState {
  value: number;
  target: number;
  label?: string | null;
  caption?: string | null;
}

const increment: BlockActionDef<ProgressRingState, { by?: number }> = {
  name: 'increment',
  description: 'Increase value by `by` (default 1).',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    properties: { by: { type: 'integer', minimum: 1, maximum: 1_000_000 } },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Progress-Ring → +{{payload.by}}',
  handler: (state, payload) => {
    const by = payload.by ?? 1;
    const next = Math.min(MAX_VALUE, state.value + by);
    return { patches: [{ path: '/value', value: next }] };
  },
};

const decrement: BlockActionDef<ProgressRingState, { by?: number }> = {
  name: 'decrement',
  description: 'Decrease value by `by` (default 1).',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    properties: { by: { type: 'integer', minimum: 1, maximum: 1_000_000 } },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Progress-Ring → -{{payload.by}}',
  handler: (state, payload) => {
    const by = payload.by ?? 1;
    const next = Math.max(MIN_VALUE, state.value - by);
    return { patches: [{ path: '/value', value: next }] };
  },
};

const setValue: BlockActionDef<ProgressRingState, { value: number }> = {
  name: 'setValue',
  description: 'Set the value directly.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['value'],
    properties: { value: { type: 'integer', minimum: MIN_VALUE, maximum: MAX_VALUE } },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Progress-Ring → set to {{payload.value}}',
  handler: (_state, payload) => ({ patches: [{ path: '/value', value: payload.value }] }),
};

const setTarget: BlockActionDef<ProgressRingState, { target: number }> = {
  name: 'setTarget',
  description: 'Change the target.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['target'],
    properties: { target: { type: 'integer', minimum: 1, maximum: MAX_VALUE } },
  },
  sensitivity: 'approval',
  approval_display_template: 'Progress-Ring → target {{payload.target}}',
  handler: (_state, payload) => ({ patches: [{ path: '/target', value: payload.target }] }),
};

const reset: BlockActionDef<ProgressRingState, Record<string, never>> = {
  name: 'reset',
  description: 'Reset value to 0.',
  payload_schema: { type: 'object', additionalProperties: false },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Progress-Ring → reset',
  handler: () => ({ patches: [{ path: '/value', value: 0 }] }),
};

const getValue: BlockQueryDef<ProgressRingState, Record<string, never>, number> = {
  name: 'getValue',
  description: 'Returns current value.',
  returns_schema: { type: 'integer' },
  compute: (state) => state.value,
};

const getTarget: BlockQueryDef<ProgressRingState, Record<string, never>, number> = {
  name: 'getTarget',
  description: 'Returns target.',
  returns_schema: { type: 'integer' },
  compute: (state) => state.target,
};

const getProgressFraction: BlockQueryDef<ProgressRingState, Record<string, never>, number> = {
  name: 'getProgressFraction',
  description: 'Returns value/target clamped to [0, 1].',
  returns_schema: { type: 'number', minimum: 0, maximum: 1 },
  compute: (state) => {
    if (state.target <= 0) return 0;
    return Math.max(0, Math.min(1, state.value / state.target));
  },
};

const getRemaining: BlockQueryDef<ProgressRingState, Record<string, never>, number> = {
  name: 'getRemaining',
  description: 'Returns target - value.',
  returns_schema: { type: 'integer', minimum: 0 },
  compute: (state) => Math.max(0, state.target - state.value),
};

export const progressRingBlock: BlockDef<ProgressRingState> = {
  type: 'progress_ring',
  description: 'Radial progress-Ring with central label.',
  state_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['value', 'target'],
    properties: {
      value: { type: 'integer', minimum: MIN_VALUE, maximum: MAX_VALUE },
      target: { type: 'integer', minimum: 1, maximum: MAX_VALUE },
      label: { type: ['string', 'null'], maxLength: 24 },
      caption: { type: ['string', 'null'], maxLength: 48 },
    },
  },
  initial_state: () => ({ value: 0, target: 100, label: null, caption: null }),
  validate: (state) => {
    if (!Number.isInteger(state.value) || state.value < MIN_VALUE || state.value > MAX_VALUE) {
      throw new Error(`progress_ring.value out of range`);
    }
    if (!Number.isInteger(state.target) || state.target <= 0 || state.target > MAX_VALUE) {
      throw new Error(`progress_ring.target must be positive integer`);
    }
  },
  actions: { increment, decrement, setValue, setTarget, reset },
  queries: { getValue, getTarget, getProgressFraction, getRemaining },
  a2ui_component: 'ProgressRing',
};
