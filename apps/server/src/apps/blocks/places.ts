/**
 * Places-Block — Adress-Liste mit Google-Maps-Open-Links.
 */
import type { BlockDef, BlockActionDef, BlockQueryDef } from './types.js';

const MAX_PLACES = 50;

export interface PlaceEntry {
  id: string;
  label: string;
  address: string;
  note?: string | null;
  url?: string | null;
}

export interface PlacesState {
  items: PlaceEntry[];
}

function genId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

const addPlace: BlockActionDef<PlacesState, { label: string; address: string; note?: string; url?: string }> = {
  name: 'addPlace',
  description: 'Add a location with label + address.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['label', 'address'],
    properties: {
      label: { type: 'string', minLength: 1, maxLength: 80 },
      address: { type: 'string', minLength: 1, maxLength: 200 },
      note: { type: 'string', maxLength: 200 },
      url: { type: 'string', pattern: '^https://', maxLength: 500 },
    },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Place + "{{payload.label}}" @ {{payload.address}}',
  handler: (state, payload) => {
    if (state.items.length >= MAX_PLACES) {
      throw new Error(`max ${MAX_PLACES} places per block`);
    }
    const entry: PlaceEntry = {
      id: genId(),
      label: payload.label,
      address: payload.address,
      note: payload.note ?? null,
      url: payload.url ?? null,
    };
    return {
      patches: [{ path: '/items', value: [...state.items, entry] }],
      result: { id: entry.id },
    };
  },
};

const updatePlace: BlockActionDef<
  PlacesState,
  { id: string; label?: string; address?: string; note?: string | null; url?: string | null }
> = {
  name: 'updatePlace',
  description: 'Update fields of an existing place.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'string', minLength: 1 },
      label: { type: 'string', minLength: 1, maxLength: 80 },
      address: { type: 'string', minLength: 1, maxLength: 200 },
      note: { type: ['string', 'null'], maxLength: 200 },
      url: { type: ['string', 'null'], pattern: '^https://', maxLength: 500 },
    },
  },
  sensitivity: 'approval',
  approval_display_template: 'Place {{payload.id}} → update',
  handler: (state, payload) => {
    const idx = state.items.findIndex((e) => e.id === payload.id);
    if (idx < 0) throw new Error(`place "${payload.id}" not found`);
    const cur = state.items[idx]!;
    const updated: PlaceEntry = {
      ...cur,
      ...(payload.label !== undefined ? { label: payload.label } : {}),
      ...(payload.address !== undefined ? { address: payload.address } : {}),
      ...(payload.note !== undefined ? { note: payload.note } : {}),
      ...(payload.url !== undefined ? { url: payload.url } : {}),
    };
    const next = [...state.items];
    next[idx] = updated;
    return { patches: [{ path: '/items', value: next }] };
  },
};

const removePlace: BlockActionDef<PlacesState, { id: string }> = {
  name: 'removePlace',
  description: 'Remove a place permanently.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string', minLength: 1 } },
  },
  sensitivity: 'approval',
  approval_display_template: 'Place {{payload.id}} → delete',
  handler: (state, payload) => {
    const next = state.items.filter((e) => e.id !== payload.id);
    if (next.length === state.items.length) {
      throw new Error(`place "${payload.id}" not found`);
    }
    return { patches: [{ path: '/items', value: next }] };
  },
};

const clearAll: BlockActionDef<PlacesState, Record<string, never>> = {
  name: 'clearAll',
  description: 'Remove ALL places.',
  payload_schema: { type: 'object', additionalProperties: false },
  sensitivity: 'approval',
  approval_display_template: 'Places → clear ALL',
  handler: () => ({ patches: [{ path: '/items', value: [] }] }),
};

const listPlaces: BlockQueryDef<PlacesState, Record<string, never>, PlaceEntry[]> = {
  name: 'listPlaces',
  description: 'Returns all places.',
  compute: (state) => state.items,
};

const count: BlockQueryDef<PlacesState, Record<string, never>, number> = {
  name: 'count',
  description: 'Count of places.',
  returns_schema: { type: 'integer', minimum: 0 },
  compute: (state) => state.items.length,
};

export const placesBlock: BlockDef<PlacesState> = {
  type: 'places',
  description: 'Adress-Liste mit Google-Maps-Open-Links.',
  state_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        maxItems: MAX_PLACES,
        items: {
          type: 'object',
          required: ['id', 'label', 'address'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 32 },
            label: { type: 'string', minLength: 1, maxLength: 80 },
            address: { type: 'string', minLength: 1, maxLength: 200 },
            note: { type: ['string', 'null'], maxLength: 200 },
            url: { type: ['string', 'null'], pattern: '^https://', maxLength: 500 },
          },
        },
      },
    },
  },
  initial_state: () => ({ items: [] }),
  validate: (state) => {
    if (!Array.isArray(state.items)) throw new Error('places.items must be array');
    if (state.items.length > MAX_PLACES) throw new Error(`places.items max ${MAX_PLACES}`);
    const ids = new Set<string>();
    for (const e of state.items) {
      if (ids.has(e.id)) throw new Error(`places duplicate id "${e.id}"`);
      ids.add(e.id);
    }
  },
  actions: { addPlace, updatePlace, removePlace, clearAll },
  queries: { listPlaces, count },
  a2ui_component: 'Places',
};
