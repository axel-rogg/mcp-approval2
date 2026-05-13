/**
 * Renderer fuer tag_filter block.
 *
 * State: { tags: string[]; active: string[] }
 * Actions: setActive(tags), addTag(tag), removeTag(tag), clearActive()
 */
import type { BlockRenderer, RenderArgs } from './types.js';
import { el, safeArray } from './types.js';

interface TagFilterState {
  readonly tags?: string[];
  readonly active?: string[];
}

export const tagFilterRenderer: BlockRenderer<TagFilterState> = {
  type: 'tag_filter',
  render({ state, onAction }: RenderArgs<TagFilterState>) {
    const tags = safeArray<string>(state.tags);
    const active = new Set(safeArray<string>(state.active));

    async function dispatch(action: string, payload?: Record<string, unknown>): Promise<void> {
      try {
        await onAction(action, payload);
      } catch (e) {
        console.error('tag_filter dispatch', action, e);
      }
    }

    function toggle(tag: string): void {
      const next = new Set(active);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      void dispatch('setActive', { tags: [...next] });
    }

    const chips = tags.map((t) =>
      el('button', {
        type: 'button',
        class: 'pill block-tag-chip' + (active.has(t) ? ' block-tag-chip--active' : ''),
        text: t,
        onclick: () => toggle(t),
      }),
    );

    return el('div', { class: 'block block-tag-filter' }, [
      tags.length === 0
        ? el('p', { class: 'muted small', text: 'No tags configured.' })
        : el('div', { class: 'row block-tag-chips' }, chips),
      active.size > 0
        ? el('button', {
            type: 'button',
            class: 'btn btn-secondary btn-small',
            text: 'Clear',
            onclick: () => void dispatch('clearActive', {}),
          })
        : null,
    ]);
  },
};
