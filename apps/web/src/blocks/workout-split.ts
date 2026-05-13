/**
 * Renderer fuer workout_split block.
 *
 * State: { categories, active_category_id, current_week_started_at, exercises[], history[] }
 *
 * Vereinfachte View: zeigt aktive Kategorie + Exercises mit Set-Toggles.
 * Volle Edit-Surface (addExercise/renameExercise) ist via Buttons gateway-ed,
 * komplexere Edits laufen ueber Claude/MCP (gem. UX-§1 agent-driven).
 */
import type { BlockRenderer, RenderArgs } from './types.js';
import { el, safeArray, safeString, safeNumber, safeBool } from './types.js';

interface CategoryDef {
  readonly id: string;
  readonly label: string;
}

interface SetEntry {
  readonly id: string;
  readonly weight: number;
  readonly reps: number;
  readonly done: boolean;
}

interface Exercise {
  readonly id: string;
  readonly category_id: string;
  readonly name: string;
  readonly order: number;
  readonly sets: SetEntry[];
}

interface WorkoutSplitState {
  readonly categories?: CategoryDef[];
  readonly active_category_id?: string;
  readonly current_week_started_at?: string;
  readonly exercises?: Exercise[];
  readonly history?: ReadonlyArray<unknown>;
}

export const workoutSplitRenderer: BlockRenderer<WorkoutSplitState> = {
  type: 'workout_split',
  render({ state, onAction }: RenderArgs<WorkoutSplitState>) {
    const cats = safeArray<CategoryDef>(state.categories);
    const activeId = safeString(state.active_category_id, cats[0]?.id ?? '');
    const week = safeString(state.current_week_started_at, '');
    const exercises = safeArray<Exercise>(state.exercises)
      .filter((e) => e.category_id === activeId)
      .slice()
      .sort((a, b) => safeNumber(a.order, 0) - safeNumber(b.order, 0));

    async function dispatch(action: string, payload?: Record<string, unknown>): Promise<void> {
      try {
        await onAction(action, payload);
      } catch (e) {
        console.error('workout_split dispatch', action, e);
      }
    }

    // category tabs
    const tabs = el(
      'div',
      { class: 'row block-workout-tabs' },
      cats.map((c) =>
        el('button', {
          type: 'button',
          class: 'btn btn-small ' + (c.id === activeId ? '' : 'btn-secondary'),
          text: safeString(c.label, c.id),
          onclick: () => void dispatch('setActiveCategory', { category_id: c.id }),
        }),
      ),
    );

    // exercises list
    const exList = el('div', { class: 'block-workout-exercises' });
    for (const ex of exercises) {
      const exName = el('div', { class: 'block-workout-exercise-name', text: safeString(ex.name, '') });
      const setRow = el('div', { class: 'row block-workout-sets' });
      for (const s of ex.sets) {
        const cb = el('input', {
          type: 'checkbox',
          onchange: () =>
            void dispatch('tickSet', {
              exercise_id: ex.id,
              set_id: s.id,
              done: !safeBool(s.done, false),
            }),
        }) as HTMLInputElement;
        cb.checked = safeBool(s.done, false);
        setRow.appendChild(
          el('label', { class: 'block-workout-set' }, [
            cb,
            el('span', { text: `${safeNumber(s.weight, 0)}×${safeNumber(s.reps, 0)}` }),
          ]),
        );
      }
      const tickAllBtn = el('button', {
        type: 'button',
        class: 'btn btn-small btn-secondary',
        text: 'All',
        onclick: () => void dispatch('tickAllInExercise', { exercise_id: ex.id, done: true }),
      });
      exList.appendChild(
        el('div', { class: 'block-workout-exercise' }, [exName, setRow, tickAllBtn]),
      );
    }

    return el('div', { class: 'block block-workout-split' }, [
      week ? el('div', { class: 'muted small', text: `Week of ${week}` }) : null,
      tabs,
      exercises.length === 0
        ? el('p', { class: 'muted small', text: 'No exercises in this category.' })
        : exList,
      el('div', { class: 'row block-workout-footer' }, [
        el('button', {
          type: 'button',
          class: 'btn btn-secondary btn-small',
          text: 'Next week',
          onclick: () => void dispatch('nextWeek', {}),
        }),
      ]),
    ]);
  },
};
