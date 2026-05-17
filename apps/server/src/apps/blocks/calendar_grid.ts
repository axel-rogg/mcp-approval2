// CalendarGrid-Block — Date-Tick-Visualisierung. Phase-2-Day-2.
//
// State: {ticks: ['YYYY-MM-DD']}. Lokales-Datums-Modell ohne TZ-Info
// (analog src/apps/types/habit_tracker/schema.ts) — der iframe-Renderer
// (Phase 2 Day 3 mit react-day-picker) zeigt die Daten in der lokalen
// Zeitzone des Users an.
//
// Actions: tick (idempotent — duplicate-add no-op), untick, clearAll.
// Queries: count, hasTick, lastTick, tickCountInRange, longestStreak,
// currentStreak.
//
// MAX_TICKS = 5000 (>13 years daily) ist die einzige hard-cap; der
// Renderer rendered eh nur sichtbare Monate, also egal wie groß ticks ist.

import type { BlockDef, BlockActionDef, BlockQueryDef } from './types.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TICKS = 5000;

export interface CalendarGridState {
  ticks: string[];  // YYYY-MM-DD, ASC sortiert + unique
}

// ---------------------------------------------------------------------------
// Date-utility — JavaScript Date in UTC fuer arithmetic, ohne TZ-Effekte.
// ---------------------------------------------------------------------------

function dateToUTC(yyyymmdd: string): Date {
  // Append T00:00:00Z forced UTC parsing — ohne das nimmt der Browser
  // local-time und subtrahiert TZ-Offset, was naive YYYY-MM-DD verfaelscht.
  return new Date(yyyymmdd + 'T00:00:00Z');
}

function utcToYYYYMMDD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function diffDays(a: string, b: string): number {
  // Wieviele Tage liegt b nach a? Negativ wenn b vor a.
  const aMs = dateToUTC(a).getTime();
  const bMs = dateToUTC(b).getTime();
  return Math.round((bMs - aMs) / 86_400_000);
}

function previousDay(yyyymmdd: string): string {
  const d = dateToUTC(yyyymmdd);
  d.setUTCDate(d.getUTCDate() - 1);
  return utcToYYYYMMDD(d);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const tick: BlockActionDef<CalendarGridState, { date: string }> = {
  name: 'tick',
  description: 'Mark a date as ticked (idempotent — adding an already-ticked date is a no-op).',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['date'],
    properties: {
      date: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
    },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Calendar → tick {{payload.date}}',
  handler: (state, payload) => {
    if (!DATE_RE.test(payload.date)) {
      throw new Error(`calendar_grid.tick: date must be YYYY-MM-DD (got ${payload.date})`);
    }
    if (state.ticks.includes(payload.date)) {
      // Idempotent — gleiche state.ticks bleiben.
      return { patches: [], result: { added: false, alreadyTicked: true } };
    }
    if (state.ticks.length >= MAX_TICKS) {
      throw new Error(`calendar_grid: max ${MAX_TICKS} ticks reached`);
    }
    // Sortiert einfuegen damit ticks ASC bleibt.
    const next = [...state.ticks, payload.date].sort();
    return {
      patches: [{ path: '/ticks', value: next }],
      result: { added: true, alreadyTicked: false },
    };
  },
};

const untick: BlockActionDef<CalendarGridState, { date: string }> = {
  name: 'untick',
  description: 'Remove a tick for the given date (no-op if not ticked).',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['date'],
    properties: {
      date: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
    },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Calendar → untick {{payload.date}}',
  handler: (state, payload) => {
    if (!DATE_RE.test(payload.date)) {
      throw new Error(`calendar_grid.untick: date must be YYYY-MM-DD (got ${payload.date})`);
    }
    if (!state.ticks.includes(payload.date)) {
      return { patches: [], result: { removed: false } };
    }
    const next = state.ticks.filter((t) => t !== payload.date);
    return {
      patches: [{ path: '/ticks', value: next }],
      result: { removed: true },
    };
  },
};

const clearAll: BlockActionDef<CalendarGridState, Record<string, never>> = {
  name: 'clearAll',
  description: 'Remove all ticks. Lossy — used for hard reset.',
  payload_schema: { type: 'object', additionalProperties: false },
  sensitivity: 'approval',
  approval_display_template: 'Calendar → clear all ticks ({{current_state.ticks.length}} entries)',
  handler: () => ({
    patches: [{ path: '/ticks', value: [] }],
  }),
};

// ---------------------------------------------------------------------------
// Queries — alle named-method-dispatch (kein Eval, Q1-Decision).
// ---------------------------------------------------------------------------

const countQuery: BlockQueryDef<CalendarGridState, Record<string, never>, number> = {
  name: 'count',
  description: 'Number of ticked dates total.',
  returns_schema: { type: 'integer', minimum: 0 },
  compute: (state) => state.ticks.length,
};

const hasTickQuery: BlockQueryDef<CalendarGridState, { date: string }, boolean> = {
  name: 'hasTick',
  description: 'Returns true if the given date is ticked.',
  args_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['date'],
    properties: {
      date: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
    },
  },
  returns_schema: { type: 'boolean' },
  compute: (state, args) => state.ticks.includes(args.date),
};

const lastTickQuery: BlockQueryDef<CalendarGridState, Record<string, never>, string | null> = {
  name: 'lastTick',
  description: 'Returns the most-recent ticked date, or null if no ticks.',
  returns_schema: { type: ['string', 'null'], pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
  compute: (state) => {
    if (state.ticks.length === 0) return null;
    // ticks bleibt ASC sortiert durch tick-Action — letzter Eintrag ist neuester.
    return state.ticks[state.ticks.length - 1] ?? null;
  },
};

const tickCountInRangeQuery: BlockQueryDef<
  CalendarGridState,
  { from: string; to: string },
  number
> = {
  name: 'tickCountInRange',
  description: 'Count of ticks in [from, to] inclusive (both YYYY-MM-DD).',
  args_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['from', 'to'],
    properties: {
      from: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
      to:   { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
    },
  },
  returns_schema: { type: 'integer', minimum: 0 },
  compute: (state, args) => {
    if (!DATE_RE.test(args.from) || !DATE_RE.test(args.to)) {
      throw new Error('tickCountInRange: from/to must be YYYY-MM-DD');
    }
    if (args.from > args.to) return 0;
    return state.ticks.filter((t) => t >= args.from && t <= args.to).length;
  },
};

// "longestStreak" = laengste durchlaufende Tagesfolge irgendwo in der History.
// "currentStreak" = Tagesfolge die am letzten Tick endet (oder 0 wenn keiner).
//
// Algorithmus fuer beide: ticks ASC sortiert, walk through, increment counter
// when previous-tick + 1 day == current-tick, else reset counter to 1.
// Track max along the way, plus current.
function computeStreaks(ticks: string[]): { longest: number; current: number } {
  if (ticks.length === 0) return { longest: 0, current: 0 };
  let run = 1;
  let longest = 1;
  for (let i = 1; i < ticks.length; i++) {
    const prev = ticks[i - 1]!;
    const cur = ticks[i]!;
    if (diffDays(prev, cur) === 1) {
      run += 1;
    } else {
      run = 1;
    }
    if (run > longest) longest = run;
  }
  // current = run ending am letzten Tick.
  return { longest, current: run };
}

const longestStreakQuery: BlockQueryDef<CalendarGridState, Record<string, never>, number> = {
  name: 'longestStreak',
  description: 'Longest run of consecutive ticked days, anywhere in history.',
  returns_schema: { type: 'integer', minimum: 0 },
  compute: (state) => computeStreaks(state.ticks).longest,
};

const currentStreakQuery: BlockQueryDef<CalendarGridState, Record<string, never>, number> = {
  name: 'currentStreak',
  description: 'Run of consecutive ticked days ending at the latest tick (0 if no ticks).',
  returns_schema: { type: 'integer', minimum: 0 },
  compute: (state) => computeStreaks(state.ticks).current,
};

// ---------------------------------------------------------------------------
// Block-Definition
// ---------------------------------------------------------------------------

export const calendarGridBlock: BlockDef<CalendarGridState> = {
  type: 'calendar_grid',
  description: 'Date-tick visualization. Stores YYYY-MM-DD strings; iframe-side react-day-picker renders the calendar.',
  state_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ticks'],
    properties: {
      ticks: {
        type: 'array',
        maxItems: MAX_TICKS,
        items: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
        description: 'YYYY-MM-DD dates, sorted ASC, unique.',
      },
    },
  },
  initial_state: () => ({ ticks: [] }),
  validate: (state) => {
    if (!Array.isArray(state.ticks)) {
      throw new Error('calendar_grid.ticks must be an array');
    }
    if (state.ticks.length > MAX_TICKS) {
      throw new Error(`calendar_grid.ticks max ${MAX_TICKS} entries`);
    }
    const seen = new Set<string>();
    for (const t of state.ticks) {
      if (typeof t !== 'string' || !DATE_RE.test(t)) {
        throw new Error(`calendar_grid.ticks contains invalid entry "${t}" (need YYYY-MM-DD)`);
      }
      if (seen.has(t)) {
        throw new Error(`calendar_grid.ticks contains duplicate ${t}`);
      }
      seen.add(t);
    }
    // Verify ASC order (defensive — actions enforce this, but persisted state could be tampered).
    for (let i = 1; i < state.ticks.length; i++) {
      if (state.ticks[i - 1]! >= state.ticks[i]!) {
        throw new Error('calendar_grid.ticks must be sorted ASC');
      }
    }
  },
  actions: { tick, untick, clearAll },
  queries: {
    count: countQuery,
    hasTick: hasTickQuery,
    lastTick: lastTickQuery,
    tickCountInRange: tickCountInRangeQuery,
    longestStreak: longestStreakQuery,
    currentStreak: currentStreakQuery,
  },
  // a2ui_component: Phase 2 Day 3 vendored react-day-picker im iframe-Bundle.
  a2ui_component: 'CalendarGrid',
};

// Helpers exportiert fuer Tests + spaetere Day-3-Renderer.
export { DATE_RE, MAX_TICKS, computeStreaks, diffDays, previousDay };
