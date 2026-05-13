// Workout-Split-Block — Wochenplan-Tracker fuer Gewichtstraining.
//
// Datenmodell: ein Block instance = vollstaendiger Wochenplan.
//   - categories[]: konfigurierbare Kategorien (Default: Ruecken/Brust/Dehnen/Beine)
//   - exercises[]: aktive Uebungen DIESER Woche, je mit sets[{weight, reps, done}]
//   - history[]: archivierte Wochen-Snapshots (nur Progress-Summary, kein Volldump)
//
// Wochen-Rollover (`nextWeek` action):
//   1. Snapshot der current week (started_at + per-category {done,total}) → history
//   2. exercises bleibt unveraendert (Carry-Over: weight, reps, Anzahl Saetze)
//   3. ALLE sets.done → false
//   4. current_week_started_at = next monday
//
// Mid-Week Anpassungen (`updateSet`): Gewicht oder Reps editieren bleibt — beim
// naechsten nextWeek() rollt der neue Wert auch in die naechste Woche.
//
// Report-Query (`report`): liefert Array von Wochen-Rows mit per-Kategorie
// percent + color-token. Color-Schwellen: 0%→red, 1-79%→yellow, 80-100%→green.

import type { BlockDef, BlockActionDef, BlockQueryDef } from './types.js';

const MAX_CATEGORIES   = 12;
const MAX_EXERCISES    = 100;
const MAX_SETS_PER_EX  = 20;
const MAX_HISTORY      = 156;        // ~3 Jahre Wochen
const DATE_RE          = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE            = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

export type ColorToken = 'red' | 'yellow' | 'green';

export interface CategoryDef {
  id:    string;     // slug, z.B. 'ruecken'
  label: string;     // human-readable, z.B. 'Rücken'
  order: number;     // sort
}

export interface SetEntry {
  id:     string;
  weight: number;    // 0 = bodyweight; non-negative; unit-agnostisch (User-Konvention: kg)
  reps:   number;    // unit-agnostisch — User interpretiert (Reps ODER Sekunden ODER Minuten)
  done:   boolean;
}

export interface Exercise {
  id:          string;
  category_id: string;
  name:        string;
  order:       number;
  sets:        SetEntry[];
}

export interface WeekSnapshot {
  week_id:           string;                                              // YYYY-MM-DD (started_at)
  started_at:        string;
  ended_at:          string;
  category_progress: Record<string, { done: number; total: number }>;     // {category_id → counts}
}

export interface WorkoutSplitState {
  categories:              CategoryDef[];
  active_category_id:      string;
  current_week_started_at: string;       // YYYY-MM-DD
  exercises:               Exercise[];
  history:                 WeekSnapshot[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function genId(prefix: string): string {
  return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function parseIso(s: string): Date {
  if (!DATE_RE.test(s)) throw new Error(`workout_split: invalid date "${s}" (expected YYYY-MM-DD)`);
  const [y, m, d] = s.split('-').map((p) => parseInt(p, 10));
  return new Date(Date.UTC(y as number, (m as number) - 1, d as number));
}

function addDaysIso(s: string, days: number): string {
  const d = parseIso(s);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

/** Returns the Monday of the week containing `s` (ISO 8601: week starts Monday). */
export function mondayOf(s: string): string {
  const d = parseIso(s);
  const dow = d.getUTCDay();                  // 0=Sun, 1=Mon, ..., 6=Sat
  const offset = dow === 0 ? -6 : 1 - dow;    // Sunday rolls back to previous Monday
  d.setUTCDate(d.getUTCDate() + offset);
  return isoDate(d);
}

export function computeProgress(exercises: Exercise[]): {
  byCategory: Record<string, { done: number; total: number }>;
  overall:    { done: number; total: number };
} {
  const byCategory: Record<string, { done: number; total: number }> = {};
  let oDone = 0;
  let oTotal = 0;
  for (const ex of exercises) {
    const bucket = byCategory[ex.category_id] ?? { done: 0, total: 0 };
    for (const s of ex.sets) {
      bucket.total += 1;
      oTotal += 1;
      if (s.done) {
        bucket.done += 1;
        oDone += 1;
      }
    }
    byCategory[ex.category_id] = bucket;
  }
  return { byCategory, overall: { done: oDone, total: oTotal } };
}

/** Color thresholds: 0% → red, 1-79% → yellow, 80-100% → green. */
export function colorFor(done: number, total: number): ColorToken {
  if (total === 0)              return 'red';
  const pct = (done / total) * 100;
  if (pct === 0)                return 'red';
  if (pct < 80)                 return 'yellow';
  return 'green';
}

// ─── Actions ─────────────────────────────────────────────────────────────

const tickSet: BlockActionDef<WorkoutSplitState, { exercise_id: string; set_id: string; done?: boolean }> = {
  name: 'tickSet',
  description: 'Toggle (or set, when `done` is given) the done-flag of a single set.',
  payload_schema: {
    type: 'object', additionalProperties: false, required: ['exercise_id', 'set_id'],
    properties: {
      exercise_id: { type: 'string', minLength: 1, maxLength: 40 },
      set_id:      { type: 'string', minLength: 1, maxLength: 40 },
      done:        { type: 'boolean' },
    },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Workout → Set {{payload.set_id}} ({{payload.exercise_id}}) toggle done',
  handler: (state, payload) => {
    const exIdx = state.exercises.findIndex((e) => e.id === payload.exercise_id);
    if (exIdx < 0) throw new Error(`exercise "${payload.exercise_id}" not found`);
    const ex = state.exercises[exIdx]!;
    const sIdx = ex.sets.findIndex((s) => s.id === payload.set_id);
    if (sIdx < 0) throw new Error(`set "${payload.set_id}" not found in exercise "${ex.id}"`);
    const cur = ex.sets[sIdx]!;
    const next: SetEntry = { ...cur, done: payload.done ?? !cur.done };
    const nextSets = [...ex.sets];
    nextSets[sIdx] = next;
    const nextEx: Exercise = { ...ex, sets: nextSets };
    const nextExs = [...state.exercises];
    nextExs[exIdx] = nextEx;
    return { patches: [{ path: '/exercises', value: nextExs }], result: { done: next.done } };
  },
};

const tickAllInExercise: BlockActionDef<WorkoutSplitState, { exercise_id: string; done: boolean }> = {
  name: 'tickAllInExercise',
  description: 'Mark all sets of an exercise as done (or undone).',
  payload_schema: {
    type: 'object', additionalProperties: false, required: ['exercise_id', 'done'],
    properties: {
      exercise_id: { type: 'string', minLength: 1, maxLength: 40 },
      done:        { type: 'boolean' },
    },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Workout → Exercise {{payload.exercise_id}} all-done={{payload.done}}',
  handler: (state, payload) => {
    const idx = state.exercises.findIndex((e) => e.id === payload.exercise_id);
    if (idx < 0) throw new Error(`exercise "${payload.exercise_id}" not found`);
    const ex = state.exercises[idx]!;
    const nextEx: Exercise = { ...ex, sets: ex.sets.map((s) => ({ ...s, done: payload.done })) };
    const nextExs = [...state.exercises];
    nextExs[idx] = nextEx;
    return { patches: [{ path: '/exercises', value: nextExs }] };
  },
};

const updateSet: BlockActionDef<WorkoutSplitState, { exercise_id: string; set_id: string; weight?: number; reps?: number }> = {
  name: 'updateSet',
  description: 'Edit weight and/or reps of an existing set (e.g. mid-week weight bump).',
  payload_schema: {
    type: 'object', additionalProperties: false, required: ['exercise_id', 'set_id'],
    properties: {
      exercise_id: { type: 'string', minLength: 1, maxLength: 40 },
      set_id:      { type: 'string', minLength: 1, maxLength: 40 },
      weight:      { type: 'number', minimum: 0,    maximum: 10000 },
      reps:        { type: 'number', minimum: 0,    maximum: 10000 },
    },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Workout → Set {{payload.set_id}}: w={{payload.weight}} r={{payload.reps}}',
  handler: (state, payload) => {
    const exIdx = state.exercises.findIndex((e) => e.id === payload.exercise_id);
    if (exIdx < 0) throw new Error(`exercise "${payload.exercise_id}" not found`);
    const ex = state.exercises[exIdx]!;
    const sIdx = ex.sets.findIndex((s) => s.id === payload.set_id);
    if (sIdx < 0) throw new Error(`set "${payload.set_id}" not found in exercise "${ex.id}"`);
    const cur = ex.sets[sIdx]!;
    const next: SetEntry = {
      ...cur,
      ...(payload.weight !== undefined ? { weight: payload.weight } : {}),
      ...(payload.reps   !== undefined ? { reps:   payload.reps   } : {}),
    };
    const nextSets = [...ex.sets];
    nextSets[sIdx] = next;
    const nextEx: Exercise = { ...ex, sets: nextSets };
    const nextExs = [...state.exercises];
    nextExs[exIdx] = nextEx;
    return { patches: [{ path: '/exercises', value: nextExs }] };
  },
};

const addSet: BlockActionDef<WorkoutSplitState, { exercise_id: string; id?: string; weight?: number; reps?: number }> = {
  name: 'addSet',
  description: 'Append a new set to an exercise. Defaults: copy weight+reps from last set, done=false. Accepts optional client-generated `id` for optimistic-UI write paths.',
  payload_schema: {
    type: 'object', additionalProperties: false, required: ['exercise_id'],
    properties: {
      exercise_id: { type: 'string', minLength: 1, maxLength: 40 },
      id:          { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,39}$' },
      weight:      { type: 'number', minimum: 0, maximum: 10000 },
      reps:        { type: 'number', minimum: 0, maximum: 10000 },
    },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Workout → +1 Set on {{payload.exercise_id}}',
  handler: (state, payload) => {
    const idx = state.exercises.findIndex((e) => e.id === payload.exercise_id);
    if (idx < 0) throw new Error(`exercise "${payload.exercise_id}" not found`);
    const ex = state.exercises[idx]!;
    if (ex.sets.length >= MAX_SETS_PER_EX) {
      throw new Error(`max ${MAX_SETS_PER_EX} sets per exercise`);
    }
    if (payload.id && ex.sets.some((s) => s.id === payload.id)) {
      throw new Error(`set id "${payload.id}" already exists in exercise`);
    }
    const last = ex.sets[ex.sets.length - 1];
    const newSet: SetEntry = {
      id:     payload.id ?? genId('s'),
      weight: payload.weight ?? last?.weight ?? 0,
      reps:   payload.reps   ?? last?.reps   ?? 10,
      done:   false,
    };
    const nextEx: Exercise = { ...ex, sets: [...ex.sets, newSet] };
    const nextExs = [...state.exercises];
    nextExs[idx] = nextEx;
    return {
      patches: [{ path: '/exercises', value: nextExs }],
      result:  { set_id: newSet.id },
    };
  },
};

const removeSet: BlockActionDef<WorkoutSplitState, { exercise_id: string; set_id: string }> = {
  name: 'removeSet',
  description: 'Remove a set from an exercise.',
  payload_schema: {
    type: 'object', additionalProperties: false, required: ['exercise_id', 'set_id'],
    properties: {
      exercise_id: { type: 'string', minLength: 1, maxLength: 40 },
      set_id:      { type: 'string', minLength: 1, maxLength: 40 },
    },
  },
  sensitivity: 'approval',
  approval_display_template: 'Workout → remove Set {{payload.set_id}}',
  handler: (state, payload) => {
    const idx = state.exercises.findIndex((e) => e.id === payload.exercise_id);
    if (idx < 0) throw new Error(`exercise "${payload.exercise_id}" not found`);
    const ex = state.exercises[idx]!;
    const nextSets = ex.sets.filter((s) => s.id !== payload.set_id);
    if (nextSets.length === ex.sets.length) {
      throw new Error(`set "${payload.set_id}" not found`);
    }
    const nextEx: Exercise = { ...ex, sets: nextSets };
    const nextExs = [...state.exercises];
    nextExs[idx] = nextEx;
    return { patches: [{ path: '/exercises', value: nextExs }] };
  },
};

const addExercise: BlockActionDef<WorkoutSplitState, {
  category_id: string;
  name:        string;
  id?:         string;
  sets?:       Array<{ id?: string; weight: number; reps: number }>;
}> = {
  name: 'addExercise',
  description: 'Add a new exercise to a category, optionally with initial sets. Accepts optional client-generated `id` (+ set-`id`s) for optimistic-UI write paths.',
  payload_schema: {
    type: 'object', additionalProperties: false, required: ['category_id', 'name'],
    properties: {
      category_id: { type: 'string', minLength: 1, maxLength: 32 },
      name:        { type: 'string', minLength: 1, maxLength: 80 },
      id:          { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,39}$' },
      sets: {
        type: 'array', maxItems: MAX_SETS_PER_EX,
        items: {
          type: 'object', additionalProperties: false, required: ['weight', 'reps'],
          properties: {
            id:     { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,39}$' },
            weight: { type: 'number', minimum: 0, maximum: 10000 },
            reps:   { type: 'number', minimum: 0, maximum: 10000 },
          },
        },
      },
    },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Workout → +Exercise "{{payload.name}}" ({{payload.category_id}})',
  handler: (state, payload) => {
    if (!state.categories.some((c) => c.id === payload.category_id)) {
      throw new Error(`category "${payload.category_id}" not found`);
    }
    if (state.exercises.length >= MAX_EXERCISES) {
      throw new Error(`max ${MAX_EXERCISES} exercises per block`);
    }
    if (payload.id && state.exercises.some((e) => e.id === payload.id)) {
      throw new Error(`exercise id "${payload.id}" already exists`);
    }
    const sets: SetEntry[] = (payload.sets ?? []).map((s) => ({
      id:     s.id ?? genId('s'),
      weight: s.weight,
      reps:   s.reps,
      done:   false,
    }));
    const orderMax = state.exercises
      .filter((e) => e.category_id === payload.category_id)
      .reduce((acc, e) => Math.max(acc, e.order), -1);
    const ex: Exercise = {
      id:          payload.id ?? genId('e'),
      category_id: payload.category_id,
      name:        payload.name,
      order:       orderMax + 1,
      sets,
    };
    return {
      patches: [{ path: '/exercises', value: [...state.exercises, ex] }],
      result:  { exercise_id: ex.id },
    };
  },
};

const removeExercise: BlockActionDef<WorkoutSplitState, { exercise_id: string }> = {
  name: 'removeExercise',
  description: 'Remove an exercise (with all its sets).',
  payload_schema: {
    type: 'object', additionalProperties: false, required: ['exercise_id'],
    properties: { exercise_id: { type: 'string', minLength: 1, maxLength: 40 } },
  },
  sensitivity: 'approval',
  approval_display_template: 'Workout → remove Exercise {{payload.exercise_id}}',
  handler: (state, payload) => {
    const next = state.exercises.filter((e) => e.id !== payload.exercise_id);
    if (next.length === state.exercises.length) {
      throw new Error(`exercise "${payload.exercise_id}" not found`);
    }
    return { patches: [{ path: '/exercises', value: next }] };
  },
};

const renameExercise: BlockActionDef<WorkoutSplitState, { exercise_id: string; name: string }> = {
  name: 'renameExercise',
  description: 'Rename an exercise.',
  payload_schema: {
    type: 'object', additionalProperties: false, required: ['exercise_id', 'name'],
    properties: {
      exercise_id: { type: 'string', minLength: 1, maxLength: 40 },
      name:        { type: 'string', minLength: 1, maxLength: 80 },
    },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Workout → rename {{payload.exercise_id}} → "{{payload.name}}"',
  handler: (state, payload) => {
    const idx = state.exercises.findIndex((e) => e.id === payload.exercise_id);
    if (idx < 0) throw new Error(`exercise "${payload.exercise_id}" not found`);
    const next = [...state.exercises];
    next[idx] = { ...next[idx]!, name: payload.name };
    return { patches: [{ path: '/exercises', value: next }] };
  },
};

const setActiveCategory: BlockActionDef<WorkoutSplitState, { category_id: string }> = {
  name: 'setActiveCategory',
  description: 'UI: pick which category is shown.',
  payload_schema: {
    type: 'object', additionalProperties: false, required: ['category_id'],
    properties: { category_id: { type: 'string', minLength: 1, maxLength: 32 } },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Workout → category {{payload.category_id}}',
  handler: (state, payload) => {
    if (!state.categories.some((c) => c.id === payload.category_id)) {
      throw new Error(`category "${payload.category_id}" not found`);
    }
    return { patches: [{ path: '/active_category_id', value: payload.category_id }] };
  },
};

const nextWeek: BlockActionDef<WorkoutSplitState, Record<string, never>> = {
  name: 'nextWeek',
  description: 'Snapshot the current week into history, reset done flags, advance current_week_started_at by 7 days. Carries over exercises + sets (weight/reps/count).',
  payload_schema: { type: 'object', additionalProperties: false },
  sensitivity: 'approval',
  approval_display_template: 'Workout → naechste Woche (Snapshot + Reset)',
  handler: (state) => {
    const progress = computeProgress(state.exercises);
    const snapshot: WeekSnapshot = {
      week_id:           state.current_week_started_at,
      started_at:        state.current_week_started_at,
      ended_at:          addDaysIso(state.current_week_started_at, 6),
      category_progress: progress.byCategory,
    };
    const nextHistory = [snapshot, ...state.history].slice(0, MAX_HISTORY);
    const resetExercises = state.exercises.map((ex) => ({
      ...ex,
      sets: ex.sets.map((s) => ({ ...s, done: false })),
    }));
    const nextStartedAt = addDaysIso(state.current_week_started_at, 7);
    return {
      patches: [
        { path: '/history',                 value: nextHistory },
        { path: '/exercises',               value: resetExercises },
        { path: '/current_week_started_at', value: nextStartedAt },
      ],
      result: { new_week: nextStartedAt, archived: snapshot.week_id },
    };
  },
};

// ─── Queries ─────────────────────────────────────────────────────────────

const currentWeekProgress: BlockQueryDef<WorkoutSplitState, Record<string, never>, {
  byCategory: Array<{ category_id: string; label: string; done: number; total: number; percent: number; color: ColorToken }>;
  overall:    { done: number; total: number; percent: number; color: ColorToken };
  started_at: string;
}> = {
  name: 'currentWeekProgress',
  description: 'Done/total per category + overall, with percent and color-token (red/yellow/green) for this week.',
  compute: (state) => {
    const { byCategory, overall } = computeProgress(state.exercises);
    return {
      started_at: state.current_week_started_at,
      byCategory: state.categories
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((c) => {
          const cur = byCategory[c.id] ?? { done: 0, total: 0 };
          const pct = cur.total === 0 ? 0 : Math.round((cur.done / cur.total) * 100);
          return {
            category_id: c.id,
            label:       c.label,
            done:        cur.done,
            total:       cur.total,
            percent:     pct,
            color:       colorFor(cur.done, cur.total),
          };
        }),
      overall: {
        done:    overall.done,
        total:   overall.total,
        percent: overall.total === 0 ? 0 : Math.round((overall.done / overall.total) * 100),
        color:   colorFor(overall.done, overall.total),
      },
    };
  },
};

const exercisesByCategory: BlockQueryDef<WorkoutSplitState, { category_id: string }, Exercise[]> = {
  name: 'exercisesByCategory',
  description: 'All exercises belonging to a category, sorted by order.',
  args_schema: {
    type: 'object', additionalProperties: false, required: ['category_id'],
    properties: { category_id: { type: 'string' } },
  },
  compute: (state, args) =>
    state.exercises
      .filter((e) => e.category_id === args.category_id)
      .sort((a, b) => a.order - b.order),
};

const report: BlockQueryDef<WorkoutSplitState, { limit?: number }, {
  weeks: Array<{
    week_id:    string;
    started_at: string;
    ended_at:   string | null;          // null for current week
    is_current: boolean;
    categories: Record<string, { done: number; total: number; percent: number; color: ColorToken }>;
    overall:    { done: number; total: number; percent: number; color: ColorToken };
  }>;
  category_order: Array<{ id: string; label: string }>;
}> = {
  name: 'report',
  description: 'Weekly report: rows = weeks (newest first, current first), columns = categories with percent + color-token. limit=N truncates older history.',
  args_schema: {
    type: 'object', additionalProperties: false,
    properties: { limit: { type: 'integer', minimum: 1, maximum: 156 } },
  },
  compute: (state, args) => {
    const limit = args.limit ?? 12;
    const catOrder = state.categories
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((c) => ({ id: c.id, label: c.label }));

    function rowFor(perCat: Record<string, { done: number; total: number }>) {
      const cats: Record<string, { done: number; total: number; percent: number; color: ColorToken }> = {};
      let oDone = 0;
      let oTotal = 0;
      for (const c of catOrder) {
        const cur = perCat[c.id] ?? { done: 0, total: 0 };
        const pct = cur.total === 0 ? 0 : Math.round((cur.done / cur.total) * 100);
        cats[c.id] = { done: cur.done, total: cur.total, percent: pct, color: colorFor(cur.done, cur.total) };
        oDone += cur.done;
        oTotal += cur.total;
      }
      return {
        categories: cats,
        overall: {
          done:    oDone,
          total:   oTotal,
          percent: oTotal === 0 ? 0 : Math.round((oDone / oTotal) * 100),
          color:   colorFor(oDone, oTotal),
        },
      };
    }

    const currentPerCat = computeProgress(state.exercises).byCategory;
    const currentRow = {
      week_id:    state.current_week_started_at,
      started_at: state.current_week_started_at,
      ended_at:   null as string | null,
      is_current: true,
      ...rowFor(currentPerCat),
    };
    const historyRows = state.history.slice(0, limit - 1).map((h) => ({
      week_id:    h.week_id,
      started_at: h.started_at,
      ended_at:   h.ended_at,
      is_current: false,
      ...rowFor(h.category_progress),
    }));
    return {
      weeks:          [currentRow, ...historyRows],
      category_order: catOrder,
    };
  },
};

const listCategories: BlockQueryDef<WorkoutSplitState, Record<string, never>, CategoryDef[]> = {
  name: 'listCategories',
  description: 'Returns all categories (sorted by order).',
  compute: (state) => state.categories.slice().sort((a, b) => a.order - b.order),
};

// ─── Block-Def ───────────────────────────────────────────────────────────

const DEFAULT_CATEGORIES: CategoryDef[] = [
  { id: 'ruecken', label: 'Rücken', order: 0 },
  { id: 'brust',   label: 'Brust',  order: 1 },
  { id: 'dehnen',  label: 'Dehnen', order: 2 },
  { id: 'beine',   label: 'Beine',  order: 3 },
];

export const workoutSplitBlock: BlockDef<WorkoutSplitState> = {
  type: 'workout_split',
  description: 'Wochenplan-Tracker fuer Gewichtstraining. Uebungen gruppiert nach Kategorie (Default: Rücken/Brust/Dehnen/Beine), je Uebung beliebig viele Saetze (weight x reps), per-Satz done-checkbox. Wochen-Rollover (nextWeek) archiviert Snapshot + resettet done-Flags, Gewicht/Reps/Anzahl-Saetze bleiben als Carry-Over erhalten. Report-Query liefert Wochen-Matrix mit Color-Coding (red/yellow/green nach Done-Percent).',
  state_schema: {
    type: 'object', additionalProperties: false,
    required: ['categories', 'active_category_id', 'current_week_started_at', 'exercises', 'history'],
    properties: {
      categories: {
        type: 'array', minItems: 1, maxItems: MAX_CATEGORIES,
        items: {
          type: 'object', additionalProperties: false, required: ['id', 'label', 'order'],
          properties: {
            id:    { type: 'string', minLength: 1, maxLength: 32, pattern: '^[a-z0-9][a-z0-9_-]{0,31}$' },
            label: { type: 'string', minLength: 1, maxLength: 32 },
            order: { type: 'integer', minimum: 0 },
          },
        },
      },
      active_category_id:      { type: 'string', minLength: 1, maxLength: 32 },
      current_week_started_at: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      exercises: {
        type: 'array', maxItems: MAX_EXERCISES,
        items: {
          type: 'object', additionalProperties: false,
          required: ['id', 'category_id', 'name', 'order', 'sets'],
          properties: {
            id:          { type: 'string', minLength: 1, maxLength: 40 },
            category_id: { type: 'string', minLength: 1, maxLength: 32 },
            name:        { type: 'string', minLength: 1, maxLength: 80 },
            order:       { type: 'integer', minimum: 0 },
            sets: {
              type: 'array', maxItems: MAX_SETS_PER_EX,
              items: {
                type: 'object', additionalProperties: false,
                required: ['id', 'weight', 'reps', 'done'],
                properties: {
                  id:     { type: 'string', minLength: 1, maxLength: 40 },
                  weight: { type: 'number', minimum: 0, maximum: 10000 },
                  reps:   { type: 'number', minimum: 0, maximum: 10000 },
                  done:   { type: 'boolean' },
                },
              },
            },
          },
        },
      },
      history: {
        type: 'array', maxItems: MAX_HISTORY,
        items: {
          type: 'object', additionalProperties: false,
          required: ['week_id', 'started_at', 'ended_at', 'category_progress'],
          properties: {
            week_id:    { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            started_at: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            ended_at:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            category_progress: {
              type: 'object',
              additionalProperties: {
                type: 'object', additionalProperties: false, required: ['done', 'total'],
                properties: {
                  done:  { type: 'integer', minimum: 0 },
                  total: { type: 'integer', minimum: 0 },
                },
              },
            },
          },
        },
      },
    },
  },
  initial_state: () => ({
    categories:              DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    active_category_id:      'ruecken',
    current_week_started_at: mondayOf(isoDate(new Date())),
    exercises:               [],
    history:                 [],
  }),
  validate: (state) => {
    if (!Array.isArray(state.categories) || state.categories.length === 0) {
      throw new Error('workout_split.categories must be non-empty array');
    }
    if (state.categories.length > MAX_CATEGORIES) {
      throw new Error(`workout_split.categories max ${MAX_CATEGORIES}`);
    }
    const catIds = new Set<string>();
    for (const c of state.categories) {
      if (!ID_RE.test(c.id)) throw new Error(`workout_split.categories: invalid id "${c.id}"`);
      if (catIds.has(c.id))  throw new Error(`workout_split.categories: duplicate id "${c.id}"`);
      catIds.add(c.id);
    }
    if (!catIds.has(state.active_category_id)) {
      throw new Error(`workout_split.active_category_id "${state.active_category_id}" not in categories`);
    }
    if (!DATE_RE.test(state.current_week_started_at)) {
      throw new Error(`workout_split.current_week_started_at must be YYYY-MM-DD`);
    }
    if (state.exercises.length > MAX_EXERCISES) {
      throw new Error(`workout_split.exercises max ${MAX_EXERCISES}`);
    }
    const exIds = new Set<string>();
    for (const ex of state.exercises) {
      if (exIds.has(ex.id))         throw new Error(`workout_split.exercises duplicate id "${ex.id}"`);
      exIds.add(ex.id);
      if (!catIds.has(ex.category_id)) {
        throw new Error(`workout_split.exercises: unknown category "${ex.category_id}"`);
      }
      if (ex.sets.length > MAX_SETS_PER_EX) {
        throw new Error(`workout_split.exercises[${ex.id}]: max ${MAX_SETS_PER_EX} sets`);
      }
      const setIds = new Set<string>();
      for (const s of ex.sets) {
        if (setIds.has(s.id)) throw new Error(`workout_split.exercises[${ex.id}]: duplicate set id "${s.id}"`);
        setIds.add(s.id);
      }
    }
    if (state.history.length > MAX_HISTORY) {
      throw new Error(`workout_split.history max ${MAX_HISTORY}`);
    }
  },
  actions: {
    tickSet,
    tickAllInExercise,
    updateSet,
    addSet,
    removeSet,
    addExercise,
    removeExercise,
    renameExercise,
    setActiveCategory,
    nextWeek,
  },
  queries: {
    currentWeekProgress,
    exercisesByCategory,
    report,
    listCategories,
  },
  a2ui_component: 'WorkoutSplit',
};
