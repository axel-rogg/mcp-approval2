/**
 * Block-Library Boot — registriert alle Bloecke beim Worker-Start.
 *
 * Multi-User-Anpassung: Boot ist global aber state-frei. registerBlock()
 * landet in einer in-process Map; Blocks selbst sind pure (kein userId-State).
 * Multi-User-Scope ist auf der API-Schicht (`AppsService.invoke({userId,...})`)
 * — Block-Definitions sind shared across users.
 */
import { _resetCatalogForTesting, listBlocks, registerBlock } from './catalog.js';
import { actionButtonBlock } from './action_button.js';
import { calendarGridBlock } from './calendar_grid.js';
import { chartBlock } from './chart.js';
import { counterBlock } from './counter.js';
import { formBlock } from './form.js';
import { headerBlock } from './header.js';
import { listBlock } from './list.js';
import { placesBlock } from './places.js';
import { progressRingBlock } from './progress_ring.js';
import { reminderBlock } from './reminder.js';
import { statCardBlock } from './stat_card.js';
import { tagFilterBlock } from './tag_filter.js';
import { textFieldBlock } from './text_field.js';
import { timerBlock } from './timer.js';
import { workoutSplitBlock } from './workout_split.js';

let _booted = false;

/**
 * Idempotent — sicheres mehrfaches Aufrufen.
 */
export function bootBlockCatalog(): void {
  if (_booted) return;
  registerBlock(actionButtonBlock);
  registerBlock(calendarGridBlock);
  registerBlock(chartBlock);
  registerBlock(counterBlock);
  registerBlock(formBlock);
  registerBlock(headerBlock);
  registerBlock(listBlock);
  registerBlock(placesBlock);
  registerBlock(progressRingBlock);
  registerBlock(reminderBlock);
  registerBlock(statCardBlock);
  registerBlock(tagFilterBlock);
  registerBlock(textFieldBlock);
  registerBlock(timerBlock);
  registerBlock(workoutSplitBlock);
  _booted = true;
}

/**
 * Test-Helper: catalog leeren und Boot-Flag zuruecksetzen.
 */
export function _resetForTesting(): void {
  _resetCatalogForTesting();
  _booted = false;
}

// Auto-Boot beim Modul-Import.
bootBlockCatalog();

// Re-exports
export { registerBlock, getBlock, listBlocks, isBlockType, _resetCatalogForTesting } from './catalog.js';
export type {
  BlockDef,
  BlockActionDef,
  BlockQueryDef,
  LayoutDoc,
  LayoutComponent,
  TemplateConfig,
  TemplateTab,
  BlockSensitivity,
} from './types.js';
export { actionButtonBlock } from './action_button.js';
export { calendarGridBlock } from './calendar_grid.js';
export { chartBlock } from './chart.js';
export { counterBlock } from './counter.js';
export { formBlock } from './form.js';
export { headerBlock } from './header.js';
export { listBlock } from './list.js';
export { placesBlock } from './places.js';
export { progressRingBlock } from './progress_ring.js';
export { reminderBlock } from './reminder.js';
export { statCardBlock } from './stat_card.js';
export { tagFilterBlock } from './tag_filter.js';
export { textFieldBlock } from './text_field.js';
export { timerBlock } from './timer.js';
export { workoutSplitBlock } from './workout_split.js';

/** Helper: list registered block-types (sorted). */
export function listBlockTypes(): string[] {
  return listBlocks().map((b) => b.type);
}
