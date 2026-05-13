/**
 * Chart-Block — Datenvisualisierung (line/bar). Config-only state.
 */
import type { BlockDef, BlockActionDef, BlockQueryDef } from './types.js';

export type ChartType = 'line' | 'bar';
export type GroupBy = 'none' | 'day' | 'iso_week' | 'month' | 'year';
export type Agg = 'count' | `sum:${string}` | `avg:${string}`;

export interface ChartState {
  chartType: ChartType;
  source: string | null;
  xField: string;
  yField?: string | null;
  groupBy: GroupBy;
  agg: Agg;
  title?: string | null;
}

function groupKey(value: unknown, by: GroupBy): string {
  const s = typeof value === 'string' ? value : String(value ?? '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  const [, yyyy, mm, dd] = m;
  switch (by) {
    case 'none':
    case 'day':
      return `${yyyy}-${mm}-${dd}`;
    case 'month':
      return `${yyyy}-${mm}`;
    case 'year':
      return `${yyyy}`;
    case 'iso_week':
      return isoWeekKey(`${yyyy}-${mm}-${dd}`);
  }
}

function isoWeekKey(yyyymmdd: string): string {
  const d = new Date(yyyymmdd + 'T00:00:00Z');
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yyyy = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(yyyy, 0, 4));
  const diffMs = d.getTime() - jan4.getTime();
  const week = 1 + Math.round(diffMs / (7 * 86_400_000));
  return `${yyyy}-W${String(week).padStart(2, '0')}`;
}

interface DataPoint {
  x: string;
  y: number;
}

export function aggregate(data: Array<Record<string, unknown>>, state: ChartState): DataPoint[] {
  if (!Array.isArray(data) || data.length === 0) return [];
  const groups = new Map<string, { sum: number; n: number; count: number }>();
  for (const item of data) {
    const xval = item[state.xField];
    const key = groupKey(xval, state.groupBy);
    const entry = groups.get(key) ?? { sum: 0, n: 0, count: 0 };
    entry.count += 1;
    if (state.agg.startsWith('sum:') || state.agg.startsWith('avg:')) {
      const yField = state.agg.split(':')[1] ?? state.yField ?? '';
      const yval = item[yField];
      if (typeof yval === 'number') {
        entry.sum += yval;
        entry.n += 1;
      }
    }
    groups.set(key, entry);
  }
  const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return sorted.map(([key, e]) => {
    let y: number;
    if (state.agg === 'count') y = e.count;
    else if (state.agg.startsWith('sum:')) y = e.sum;
    else if (state.agg.startsWith('avg:')) y = e.n > 0 ? e.sum / e.n : 0;
    else y = e.count;
    return { x: key, y };
  });
}

const setChartType: BlockActionDef<ChartState, { chartType: ChartType }> = {
  name: 'setChartType',
  description: 'Switch between line + bar.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['chartType'],
    properties: { chartType: { type: 'string', enum: ['line', 'bar'] } },
  },
  sensitivity: 'approval',
  approval_display_template: 'Chart → set type to {{payload.chartType}}',
  handler: (_state, payload) => ({ patches: [{ path: '/chartType', value: payload.chartType }] }),
};

const setSource: BlockActionDef<ChartState, { source: string | null }> = {
  name: 'setSource',
  description: 'Set the source-block-id.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['source'],
    properties: { source: { type: ['string', 'null'], maxLength: 100 } },
  },
  sensitivity: 'approval',
  approval_display_template: 'Chart → bind to source "{{payload.source}}"',
  handler: (_state, payload) => ({ patches: [{ path: '/source', value: payload.source }] }),
};

const setGroupBy: BlockActionDef<ChartState, { groupBy: GroupBy }> = {
  name: 'setGroupBy',
  description: 'Set the temporal grouping.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['groupBy'],
    properties: {
      groupBy: { type: 'string', enum: ['none', 'day', 'iso_week', 'month', 'year'] },
    },
  },
  sensitivity: 'approval',
  approval_display_template: 'Chart → groupBy {{payload.groupBy}}',
  handler: (_state, payload) => ({ patches: [{ path: '/groupBy', value: payload.groupBy }] }),
};

const setAgg: BlockActionDef<ChartState, { agg: Agg }> = {
  name: 'setAgg',
  description: 'Set the aggregation: count | sum:<field> | avg:<field>.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['agg'],
    properties: {
      agg: { type: 'string', pattern: '^(count|sum:[a-zA-Z0-9_]+|avg:[a-zA-Z0-9_]+)$' },
    },
  },
  sensitivity: 'approval',
  approval_display_template: 'Chart → agg {{payload.agg}}',
  handler: (_state, payload) => ({ patches: [{ path: '/agg', value: payload.agg }] }),
};

const dataPointsQuery: BlockQueryDef<
  ChartState,
  { data: Array<Record<string, unknown>> },
  DataPoint[]
> = {
  name: 'dataPoints',
  description: 'Aggregate + group the supplied source-block data into {x, y}-points.',
  args_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['data'],
    properties: { data: { type: 'array', items: { type: 'object' } } },
  },
  returns_schema: {
    type: 'array',
    items: {
      type: 'object',
      properties: { x: { type: 'string' }, y: { type: 'number' } },
    },
  },
  compute: (state, args) => aggregate(args.data, state),
};

const configQuery: BlockQueryDef<ChartState, Record<string, never>, ChartState> = {
  name: 'config',
  description: 'Returns the current chart-config.',
  returns_schema: { type: 'object' },
  compute: (state) => state,
};

export const chartBlock: BlockDef<ChartState> = {
  type: 'chart',
  description: 'Line/bar chart with declarative source-binding.',
  state_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['chartType', 'source', 'xField', 'groupBy', 'agg'],
    properties: {
      chartType: { type: 'string', enum: ['line', 'bar'] },
      source: { type: ['string', 'null'], maxLength: 100 },
      xField: { type: 'string', minLength: 1, maxLength: 100 },
      yField: { type: ['string', 'null'], maxLength: 100 },
      groupBy: { type: 'string', enum: ['none', 'day', 'iso_week', 'month', 'year'] },
      agg: { type: 'string', pattern: '^(count|sum:[a-zA-Z0-9_]+|avg:[a-zA-Z0-9_]+)$' },
      title: { type: ['string', 'null'], maxLength: 200 },
    },
  },
  initial_state: () => ({
    chartType: 'bar',
    source: null,
    xField: 'date',
    yField: null,
    groupBy: 'iso_week',
    agg: 'count',
    title: null,
  }),
  validate: (state) => {
    if (!['line', 'bar'].includes(state.chartType)) {
      throw new Error(`chart.chartType must be line|bar (got ${state.chartType})`);
    }
    if (typeof state.xField !== 'string' || state.xField.length === 0) {
      throw new Error('chart.xField required');
    }
    if (!['none', 'day', 'iso_week', 'month', 'year'].includes(state.groupBy)) {
      throw new Error(`chart.groupBy invalid (got ${state.groupBy})`);
    }
    if (!/^(count|sum:[a-zA-Z0-9_]+|avg:[a-zA-Z0-9_]+)$/.test(state.agg)) {
      throw new Error(`chart.agg must match count|sum:field|avg:field (got ${state.agg})`);
    }
  },
  actions: { setChartType, setSource, setGroupBy, setAgg },
  queries: { dataPoints: dataPointsQuery, config: configQuery },
  a2ui_component: 'Chart',
};

export { isoWeekKey, groupKey };
