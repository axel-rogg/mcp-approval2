/**
 * List-Block — Items mit text + optional tag/done.
 */
import type { BlockDef, BlockActionDef, BlockQueryDef } from './types.js';

export interface ListItem {
  id: string;
  text: string;
  tag?: string | null;
  done?: boolean;
  order: number;
}

export interface ListState {
  items: ListItem[];
}

const MAX_ITEMS = 1000;
const MAX_TEXT_LEN = 4000;
const MAX_TAG_LEN = 64;

function genId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

const addItem: BlockActionDef<ListState, { text: string; tag?: string | null }> = {
  name: 'addItem',
  description: 'Append a new item to the list with auto-generated id + order.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: { type: 'string', minLength: 1, maxLength: MAX_TEXT_LEN },
      tag: { type: ['string', 'null'], maxLength: MAX_TAG_LEN },
    },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'List → add "{{payload.text}}"',
  handler: (state, payload) => {
    if (state.items.length >= MAX_ITEMS) {
      throw new Error(`list: max ${MAX_ITEMS} items`);
    }
    const newItem: ListItem = {
      id: genId(),
      text: payload.text,
      tag: payload.tag ?? null,
      done: false,
      order: state.items.length,
    };
    return {
      patches: [{ path: '/items', value: [...state.items, newItem] }],
      result: { addedId: newItem.id },
    };
  },
};

const toggleItem: BlockActionDef<ListState, { id: string }> = {
  name: 'toggleItem',
  description: 'Flip the done-state of an item.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string', minLength: 1 } },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'List → toggle item id={{payload.id}}',
  handler: (state, payload) => {
    const idx = state.items.findIndex((it) => it.id === payload.id);
    if (idx < 0) throw new Error(`list: item id="${payload.id}" not found`);
    const item = state.items[idx]!;
    const updated = { ...item, done: !item.done };
    const newItems = [...state.items];
    newItems[idx] = updated;
    return {
      patches: [{ path: '/items', value: newItems }],
      result: { id: payload.id, done: updated.done },
    };
  },
};

const deleteItem: BlockActionDef<ListState, { id: string }> = {
  name: 'deleteItem',
  description: 'Remove an item from the list. Reflows order indices of remaining items.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string', minLength: 1 } },
  },
  sensitivity: 'approval',
  approval_display_template: 'List → delete item id={{payload.id}}',
  handler: (state, payload) => {
    const idx = state.items.findIndex((it) => it.id === payload.id);
    if (idx < 0) return { patches: [], result: { deleted: false } };
    const newItems = state.items.filter((it) => it.id !== payload.id).map((it, i) => ({ ...it, order: i }));
    return { patches: [{ path: '/items', value: newItems }], result: { deleted: true } };
  },
};

const setTag: BlockActionDef<ListState, { id: string; tag: string | null }> = {
  name: 'setTag',
  description: 'Set or clear the tag on an item. tag=null clears.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'tag'],
    properties: {
      id: { type: 'string', minLength: 1 },
      tag: { type: ['string', 'null'], maxLength: MAX_TAG_LEN },
    },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'List → set tag of id={{payload.id}} to {{payload.tag}}',
  handler: (state, payload) => {
    const idx = state.items.findIndex((it) => it.id === payload.id);
    if (idx < 0) throw new Error(`list: item id="${payload.id}" not found`);
    const newItems = [...state.items];
    newItems[idx] = { ...newItems[idx]!, tag: payload.tag };
    return { patches: [{ path: '/items', value: newItems }] };
  },
};

const setOrder: BlockActionDef<ListState, { ids: string[] }> = {
  name: 'setOrder',
  description: 'Reorder items by id-array. Must contain exactly the existing ids.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ids'],
    properties: {
      ids: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: MAX_ITEMS },
    },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'List → reorder ({{payload.ids.length}} items)',
  handler: (state, payload) => {
    const stateIds = state.items.map((it) => it.id).sort();
    const payloadIds = [...payload.ids].sort();
    if (stateIds.length !== payloadIds.length || stateIds.some((id, i) => id !== payloadIds[i])) {
      throw new Error('list.setOrder: ids must be exactly the current items (permutation only)');
    }
    const byId = new Map(state.items.map((it) => [it.id, it]));
    const newItems = payload.ids.map((id, i) => ({ ...byId.get(id)!, order: i }));
    return { patches: [{ path: '/items', value: newItems }] };
  },
};

const clearDone: BlockActionDef<ListState, Record<string, never>> = {
  name: 'clearDone',
  description: 'Remove all items where done=true.',
  payload_schema: { type: 'object', additionalProperties: false, properties: {} },
  sensitivity: 'approval',
  approval_display_template: 'List → clear all done items',
  handler: (state) => {
    const remaining = state.items.filter((it) => !it.done);
    if (remaining.length === state.items.length) return { patches: [], result: { removed: 0 } };
    const reflowed = remaining.map((it, i) => ({ ...it, order: i }));
    return {
      patches: [{ path: '/items', value: reflowed }],
      result: { removed: state.items.length - remaining.length },
    };
  },
};

const countQuery: BlockQueryDef<ListState, Record<string, never>, number> = {
  name: 'count',
  description: 'Total number of items.',
  returns_schema: { type: 'integer', minimum: 0 },
  compute: (state) => state.items.length,
};

const countWithTagQuery: BlockQueryDef<ListState, { tag: string }, number> = {
  name: 'countWithTag',
  description: 'Number of items with the given tag.',
  args_schema: {
    type: 'object',
    required: ['tag'],
    properties: { tag: { type: 'string' } },
  },
  returns_schema: { type: 'integer', minimum: 0 },
  compute: (state, args) => state.items.filter((it) => it.tag === args.tag).length,
};

const lastNQuery: BlockQueryDef<ListState, { n: number }, ListItem[]> = {
  name: 'lastN',
  description: 'Last N items by order.',
  args_schema: {
    type: 'object',
    required: ['n'],
    properties: { n: { type: 'integer', minimum: 1, maximum: 100 } },
  },
  returns_schema: { type: 'array', items: { type: 'object' } },
  compute: (state, args) => {
    const sorted = [...state.items].sort((a, b) => b.order - a.order);
    return sorted.slice(0, args.n);
  },
};

const doneRatioQuery: BlockQueryDef<ListState, Record<string, never>, number> = {
  name: 'doneRatio',
  description: 'Fraction of done items (0..1).',
  returns_schema: { type: 'number', minimum: 0, maximum: 1 },
  compute: (state) => {
    if (state.items.length === 0) return 0;
    const done = state.items.filter((it) => it.done).length;
    return done / state.items.length;
  },
};

const itemsInRangeQuery: BlockQueryDef<ListState, { from: number; to: number }, ListItem[]> = {
  name: 'itemsInRange',
  description: 'Items whose order is within [from, to).',
  args_schema: {
    type: 'object',
    required: ['from', 'to'],
    properties: {
      from: { type: 'integer', minimum: 0 },
      to: { type: 'integer', minimum: 0 },
    },
  },
  returns_schema: { type: 'array', items: { type: 'object' } },
  compute: (state, args) =>
    state.items.filter((it) => it.order >= args.from && it.order < args.to).sort((a, b) => a.order - b.order),
};

export const listBlock: BlockDef<ListState> = {
  type: 'list',
  description: 'Generic ordered list of items with text + optional tag + done-flag.',
  state_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        maxItems: MAX_ITEMS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'text', 'order'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 64 },
            text: { type: 'string', minLength: 1, maxLength: MAX_TEXT_LEN },
            tag: { type: ['string', 'null'], maxLength: MAX_TAG_LEN },
            done: { type: 'boolean' },
            order: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
  },
  initial_state: () => ({ items: [] }),
  validate: (state) => {
    if (!Array.isArray(state.items)) throw new Error('list.items must be array');
    if (state.items.length > MAX_ITEMS) throw new Error(`list: max ${MAX_ITEMS} items`);
    const ids = new Set<string>();
    for (const it of state.items) {
      if (!it.id) throw new Error('list item missing id');
      if (ids.has(it.id)) throw new Error(`list: duplicate item id "${it.id}"`);
      ids.add(it.id);
      if (typeof it.text !== 'string' || it.text.length === 0) {
        throw new Error(`list item id="${it.id}": text must be non-empty string`);
      }
      if (it.text.length > MAX_TEXT_LEN) {
        throw new Error(`list item id="${it.id}": text exceeds ${MAX_TEXT_LEN} chars`);
      }
    }
  },
  actions: { addItem, toggleItem, deleteItem, setTag, setOrder, clearDone },
  queries: {
    count: countQuery,
    countWithTag: countWithTagQuery,
    lastN: lastNQuery,
    doneRatio: doneRatioQuery,
    itemsInRange: itemsInRangeQuery,
  },
  a2ui_component: 'List',
};
