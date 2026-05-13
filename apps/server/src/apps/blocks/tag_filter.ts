/**
 * TagFilter-Block — chip-style multi-select fuer Listen-Filtering.
 */
import type { BlockDef, BlockActionDef, BlockQueryDef } from './types.js';

export interface TagFilterState {
  tags: string[];
  active: string[];
}

function ensureSubset(active: string[], tags: string[]): void {
  const unknown = active.filter((t) => !tags.includes(t));
  if (unknown.length > 0) {
    throw new Error(`tag_filter: active tag(s) not in tags-list: ${unknown.join(', ')}`);
  }
}

const setActive: BlockActionDef<TagFilterState, { active: string[] }> = {
  name: 'setActive',
  description: 'Set the full active-tags list.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['active'],
    properties: {
      active: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 64 }, maxItems: 50 },
    },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'TagFilter → active = [{{payload.active}}]',
  handler: (state, payload) => {
    ensureSubset(payload.active, state.tags);
    const seen = new Set<string>();
    const dedup = payload.active.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
    return { patches: [{ path: '/active', value: dedup }] };
  },
};

const addTag: BlockActionDef<TagFilterState, { tag: string }> = {
  name: 'addTag',
  description: 'Add a new tag option to the available-tags list.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['tag'],
    properties: { tag: { type: 'string', minLength: 1, maxLength: 64 } },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'TagFilter → add tag "{{payload.tag}}"',
  handler: (state, payload) => {
    if (state.tags.includes(payload.tag)) return { patches: [] };
    if (state.tags.length >= 100) throw new Error('tag_filter: max 100 tags');
    return { patches: [{ path: '/tags', value: [...state.tags, payload.tag] }] };
  },
};

const removeTag: BlockActionDef<TagFilterState, { tag: string }> = {
  name: 'removeTag',
  description: 'Remove a tag from the available-tags list.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['tag'],
    properties: { tag: { type: 'string', minLength: 1, maxLength: 64 } },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'TagFilter → remove tag "{{payload.tag}}"',
  handler: (state, payload) => {
    const newTags = state.tags.filter((t) => t !== payload.tag);
    const newActive = state.active.filter((t) => t !== payload.tag);
    const patches: Array<{ path: string; value: unknown }> = [];
    if (newTags.length !== state.tags.length) patches.push({ path: '/tags', value: newTags });
    if (newActive.length !== state.active.length) patches.push({ path: '/active', value: newActive });
    return { patches };
  },
};

const clearActive: BlockActionDef<TagFilterState, Record<string, never>> = {
  name: 'clearActive',
  description: 'Clear all active tags.',
  payload_schema: { type: 'object', additionalProperties: false, properties: {} },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'TagFilter → clear all active filters',
  handler: () => ({ patches: [{ path: '/active', value: [] }] }),
};

const activeQuery: BlockQueryDef<TagFilterState, Record<string, never>, string[]> = {
  name: 'activeTags',
  description: 'Return the currently-active tags list.',
  returns_schema: { type: 'array', items: { type: 'string' } },
  compute: (state) => state.active,
};

const allTagsQuery: BlockQueryDef<TagFilterState, Record<string, never>, string[]> = {
  name: 'allTags',
  description: 'Return the full list of available tags.',
  returns_schema: { type: 'array', items: { type: 'string' } },
  compute: (state) => state.tags,
};

const isActiveQuery: BlockQueryDef<TagFilterState, { tag: string }, boolean> = {
  name: 'isActive',
  description: 'Check whether a specific tag is currently active.',
  args_schema: {
    type: 'object',
    required: ['tag'],
    properties: { tag: { type: 'string' } },
  },
  returns_schema: { type: 'boolean' },
  compute: (state, args) => state.active.includes(args.tag),
};

export const tagFilterBlock: BlockDef<TagFilterState> = {
  type: 'tag_filter',
  description: 'Multi-select tag filter — chip-style.',
  state_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['tags', 'active'],
    properties: {
      tags: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 64 }, maxItems: 100 },
      active: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 64 }, maxItems: 100 },
    },
  },
  initial_state: () => ({ tags: [], active: [] }),
  validate: (state) => {
    if (!Array.isArray(state.tags)) throw new Error('tag_filter.tags must be array');
    if (!Array.isArray(state.active)) throw new Error('tag_filter.active must be array');
    if (state.tags.length > 100) throw new Error('tag_filter: max 100 tags');
    ensureSubset(state.active, state.tags);
  },
  actions: { setActive, addTag, removeTag, clearActive },
  queries: { activeTags: activeQuery, allTags: allTagsQuery, isActive: isActiveQuery },
  a2ui_component: 'TagFilter',
};
