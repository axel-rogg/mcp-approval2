/**
 * Stat-Card-Block — KPI-Tile mit Title + Big-Value + optional Delta + Sparkline.
 */
import type { BlockDef, BlockActionDef, BlockQueryDef } from './types.js';

const SPARKLINE_MAX = 30;

export interface StatCardState {
  value: number;
  label?: string | null;
  delta?: number | null;
  sparkline?: number[];
  unit?: string | null;
}

const setValue: BlockActionDef<StatCardState, { value: number; delta?: number | null }> = {
  name: 'setValue',
  description: 'Set the main value (and optionally delta).',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['value'],
    properties: {
      value: { type: 'number' },
      delta: { type: ['number', 'null'] },
    },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Stat-Card → {{payload.value}}',
  handler: (_state, payload) => {
    const patches: Array<{ path: string; value: unknown }> = [{ path: '/value', value: payload.value }];
    if (payload.delta !== undefined) patches.push({ path: '/delta', value: payload.delta });
    return { patches };
  },
};

const setDelta: BlockActionDef<StatCardState, { delta: number | null }> = {
  name: 'setDelta',
  description: 'Set or clear the delta-indicator.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['delta'],
    properties: { delta: { type: ['number', 'null'] } },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Stat-Card → delta {{payload.delta}}',
  handler: (_state, payload) => ({ patches: [{ path: '/delta', value: payload.delta }] }),
};

const pushSparkline: BlockActionDef<StatCardState, { value: number }> = {
  name: 'pushSparkline',
  description: 'Append a value to the sparkline series.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['value'],
    properties: { value: { type: 'number' } },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Stat-Card → sparkline+ {{payload.value}}',
  handler: (state, payload) => {
    const cur = state.sparkline ?? [];
    const next = [...cur, payload.value];
    const trimmed = next.length > SPARKLINE_MAX ? next.slice(-SPARKLINE_MAX) : next;
    return { patches: [{ path: '/sparkline', value: trimmed }] };
  },
};

const reset: BlockActionDef<StatCardState, Record<string, never>> = {
  name: 'reset',
  description: 'Reset value to 0, clear delta + sparkline.',
  payload_schema: { type: 'object', additionalProperties: false },
  sensitivity: 'approval',
  approval_display_template: 'Stat-Card → reset',
  handler: () => ({
    patches: [
      { path: '/value', value: 0 },
      { path: '/delta', value: null },
      { path: '/sparkline', value: [] },
    ],
  }),
};

const getValue: BlockQueryDef<StatCardState, Record<string, never>, number> = {
  name: 'getValue',
  description: 'Returns the main value.',
  returns_schema: { type: 'number' },
  compute: (state) => state.value,
};

const getDelta: BlockQueryDef<StatCardState, Record<string, never>, number | null> = {
  name: 'getDelta',
  description: 'Returns the delta or null.',
  returns_schema: { type: ['number', 'null'] },
  compute: (state) => state.delta ?? null,
};

const getTrend: BlockQueryDef<StatCardState, Record<string, never>, 'up' | 'down' | 'flat' | 'unknown'> = {
  name: 'getTrend',
  description: 'Returns trend based on delta sign.',
  returns_schema: { type: 'string', enum: ['up', 'down', 'flat', 'unknown'] },
  compute: (state) => {
    if (state.delta == null) return 'unknown';
    if (state.delta > 0) return 'up';
    if (state.delta < 0) return 'down';
    return 'flat';
  },
};

export const statCardBlock: BlockDef<StatCardState> = {
  type: 'stat_card',
  description: 'KPI-Tile: Big-Value + optional Delta + optional Sparkline.',
  state_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['value'],
    properties: {
      value: { type: 'number' },
      label: { type: ['string', 'null'], maxLength: 48 },
      delta: { type: ['number', 'null'] },
      sparkline: { type: 'array', maxItems: SPARKLINE_MAX, items: { type: 'number' } },
      unit: { type: ['string', 'null'], maxLength: 8 },
    },
  },
  initial_state: () => ({ value: 0, label: null, delta: null, sparkline: [], unit: null }),
  validate: (state) => {
    if (typeof state.value !== 'number' || !Number.isFinite(state.value)) {
      throw new Error('stat_card.value must be finite number');
    }
    if (state.sparkline && state.sparkline.length > SPARKLINE_MAX) {
      throw new Error(`stat_card.sparkline max ${SPARKLINE_MAX} entries`);
    }
  },
  actions: { setValue, setDelta, pushSparkline, reset },
  queries: { getValue, getDelta, getTrend },
  a2ui_component: 'StatCard',
};
