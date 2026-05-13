/**
 * Frontend Block-Renderer Registry.
 *
 * Pendant zum Backend-Block-Catalog (apps/server/src/apps/blocks/catalog.ts).
 * Backend registriert state + actions + queries — Frontend registriert die
 * visual rendering.
 *
 * 13 Renderer (Burst 7): action_button, chart, counter, form, list, places,
 * progress_ring, reminder, stat_card, tag_filter, text_field, timer, workout_split.
 */
import type { BlockRenderer } from './types.js';
import { actionButtonRenderer } from './action-button.js';
import { chartRenderer } from './chart.js';
import { counterRenderer } from './counter.js';
import { formRenderer } from './form.js';
import { listRenderer } from './list.js';
import { placesRenderer } from './places.js';
import { progressRingRenderer } from './progress-ring.js';
import { reminderRenderer } from './reminder.js';
import { statCardRenderer } from './stat-card.js';
import { tagFilterRenderer } from './tag-filter.js';
import { textFieldRenderer } from './text-field.js';
import { timerRenderer } from './timer.js';
import { workoutSplitRenderer } from './workout-split.js';

const REGISTRY = new Map<string, BlockRenderer>();

function register<T>(r: BlockRenderer<T>): void {
  REGISTRY.set(r.type, r as BlockRenderer);
}

register(actionButtonRenderer);
register(chartRenderer);
register(counterRenderer);
register(formRenderer);
register(listRenderer);
register(placesRenderer);
register(progressRingRenderer);
register(reminderRenderer);
register(statCardRenderer);
register(tagFilterRenderer);
register(textFieldRenderer);
register(timerRenderer);
register(workoutSplitRenderer);

export function getRenderer(type: string): BlockRenderer | undefined {
  return REGISTRY.get(type);
}

export function listRendererTypes(): string[] {
  return [...REGISTRY.keys()].sort();
}
