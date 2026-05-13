/**
 * Renderer fuer list block.
 *
 * State: { items: ListItem[] } with ListItem { id, text, tag?, done?, order }
 * Actions: addItem(text, tag?), toggleItem(id), deleteItem(id), clearDone(), setTag(id, tag), setOrder(id, order)
 */
import type { BlockRenderer, RenderArgs } from './types.js';
import { el, safeArray, safeString, safeBool } from './types.js';

interface ListItem {
  readonly id: string;
  readonly text: string;
  readonly tag?: string | null;
  readonly done?: boolean;
  readonly order: number;
}

interface ListState {
  readonly items?: ListItem[];
}

export const listRenderer: BlockRenderer<ListState> = {
  type: 'list',
  render({ state, onAction }: RenderArgs<ListState>) {
    const items = safeArray<ListItem>(state.items).slice().sort((a, b) => {
      const oa = typeof a.order === 'number' ? a.order : 0;
      const ob = typeof b.order === 'number' ? b.order : 0;
      return oa - ob;
    });

    async function dispatch(action: string, payload?: Record<string, unknown>): Promise<void> {
      try {
        await onAction(action, payload);
      } catch (e) {
        console.error('list dispatch', action, e);
      }
    }

    const addInput = el('input', {
      type: 'text',
      class: 'block-list-add-input',
      placeholder: 'New item…',
      maxlength: 4000,
    }) as HTMLInputElement;

    const tagInput = el('input', {
      type: 'text',
      class: 'block-list-add-tag',
      placeholder: 'tag (optional)',
      maxlength: 64,
    }) as HTMLInputElement;

    async function addItem(): Promise<void> {
      const text = addInput.value.trim();
      if (!text) return;
      const tag = tagInput.value.trim();
      const payload: Record<string, unknown> = { text };
      if (tag) payload['tag'] = tag;
      addInput.value = '';
      tagInput.value = '';
      await dispatch('addItem', payload);
    }

    const addBtn = el('button', {
      type: 'button',
      class: 'btn btn-small',
      text: 'Add',
      onclick: () => void addItem(),
    });

    addInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        e.preventDefault();
        void addItem();
      }
    });

    const ul = el('ul', { class: 'block-list-items' });
    for (const it of items) {
      const checkbox = el('input', {
        type: 'checkbox',
        onchange: () => void dispatch('toggleItem', { id: it.id }),
      }) as HTMLInputElement;
      checkbox.checked = safeBool(it.done, false);

      const textEl = el('span', {
        class: 'block-list-item-text' + (it.done ? ' done' : ''),
        text: safeString(it.text, ''),
      });

      const tag = safeString(it.tag ?? undefined, '');
      const tagEl = tag ? el('span', { class: 'pill block-list-item-tag', text: tag }) : null;

      const delBtn = el('button', {
        type: 'button',
        class: 'btn btn-secondary btn-small',
        text: '×',
        title: 'Delete',
        onclick: () => void dispatch('deleteItem', { id: it.id }),
      });

      ul.appendChild(
        el('li', { class: 'block-list-item' }, [checkbox, textEl, tagEl, delBtn]),
      );
    }

    return el('div', { class: 'block block-list' }, [
      el('div', { class: 'row block-list-add' }, [addInput, tagInput, addBtn]),
      items.length === 0 ? el('p', { class: 'muted small', text: 'No items yet.' }) : ul,
      items.some((i) => i.done)
        ? el('div', { class: 'row block-list-footer' }, [
            el('button', {
              type: 'button',
              class: 'btn btn-secondary btn-small',
              text: 'Clear done',
              onclick: () => void dispatch('clearDone', {}),
            }),
          ])
        : null,
    ]);
  },
};
