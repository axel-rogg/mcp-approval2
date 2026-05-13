/**
 * Renderer fuer places block.
 *
 * State: { items: PlaceEntry[] } with PlaceEntry { id, label, address, note?, url? }
 * Actions: addPlace, updatePlace, removePlace, clearAll
 */
import type { BlockRenderer, RenderArgs } from './types.js';
import { el, safeArray, safeString } from './types.js';

interface PlaceEntry {
  readonly id: string;
  readonly label: string;
  readonly address: string;
  readonly note?: string | null;
  readonly url?: string | null;
}

interface PlacesState {
  readonly items?: PlaceEntry[];
}

function mapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

export const placesRenderer: BlockRenderer<PlacesState> = {
  type: 'places',
  render({ state, onAction }: RenderArgs<PlacesState>) {
    const items = safeArray<PlaceEntry>(state.items);

    async function dispatch(action: string, payload?: Record<string, unknown>): Promise<void> {
      try {
        await onAction(action, payload);
      } catch (e) {
        console.error('places dispatch', action, e);
      }
    }

    const labelInput = el('input', {
      type: 'text',
      placeholder: 'Label',
      maxlength: 80,
      class: 'block-places-input',
    }) as HTMLInputElement;
    const addrInput = el('input', {
      type: 'text',
      placeholder: 'Address',
      maxlength: 400,
      class: 'block-places-input',
    }) as HTMLInputElement;

    async function addPlace(): Promise<void> {
      const label = labelInput.value.trim();
      const address = addrInput.value.trim();
      if (!label || !address) return;
      labelInput.value = '';
      addrInput.value = '';
      await dispatch('addPlace', { label, address });
    }

    const addBtn = el('button', {
      type: 'button',
      class: 'btn btn-small',
      text: 'Add place',
      onclick: () => void addPlace(),
    });

    const ul = el('ul', { class: 'block-places-items' });
    for (const p of items) {
      const url = safeString(p.url ?? undefined, '') || mapsUrl(p.address);
      ul.appendChild(
        el('li', { class: 'block-places-item' }, [
          el('div', { class: 'block-places-item-main' }, [
            el('div', { class: 'block-places-item-label', text: safeString(p.label, '') }),
            el('div', { class: 'muted small', text: safeString(p.address, '') }),
            p.note ? el('div', { class: 'small', text: safeString(p.note, '') }) : null,
          ]),
          el('div', { class: 'row block-places-item-actions' }, [
            el('a', {
              class: 'btn btn-secondary btn-small',
              href: url,
              target: '_blank',
              rel: 'noopener noreferrer',
              text: 'Map',
            }),
            el('button', {
              type: 'button',
              class: 'btn btn-secondary btn-small',
              text: '×',
              title: 'Remove',
              onclick: () => void dispatch('removePlace', { id: p.id }),
            }),
          ]),
        ]),
      );
    }

    return el('div', { class: 'block block-places' }, [
      el('div', { class: 'row block-places-add' }, [labelInput, addrInput, addBtn]),
      items.length === 0 ? el('p', { class: 'muted small', text: 'No places yet.' }) : ul,
    ]);
  },
};
