// Header-Block — Titel mit optionalem Subtitel + Icon. Erste Block-
// Implementierung; Pattern-Setter fuer alle weiteren simplen Bloecke.
//
// PLAN-Reference: docs/plans/PLAN-apps-blocks.md §3.1 (Block-Library-Tabelle)

import type { BlockDef, BlockActionDef, BlockQueryDef } from './types.js';

export interface HeaderState {
  title: string;
  subtitle?: string | null;
  icon?: string | null;
}

const setTitle: BlockActionDef<HeaderState, { title: string }> = {
  name: 'setTitle',
  description: 'Set the header title.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['title'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
    },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Header → set title to "{{payload.title}}"',
  handler: (_state, payload) => ({
    patches: [{ path: '/title', value: payload.title }],
  }),
};

const setSubtitle: BlockActionDef<HeaderState, { subtitle: string | null }> = {
  name: 'setSubtitle',
  description: 'Set or clear the header subtitle.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['subtitle'],
    properties: {
      subtitle: { type: ['string', 'null'], maxLength: 200 },
    },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Header → set subtitle to "{{payload.subtitle}}"',
  handler: (_state, payload) => ({
    patches: [{ path: '/subtitle', value: payload.subtitle }],
  }),
};

const titleQuery: BlockQueryDef<HeaderState, Record<string, never>, string> = {
  name: 'title',
  description: 'Returns the current header title.',
  returns_schema: { type: 'string' },
  compute: (state) => state.title,
};

export const headerBlock: BlockDef<HeaderState> = {
  type: 'header',
  description: 'A title header with optional subtitle + icon. Display-only — no list-of-children semantics.',
  state_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['title'],
    properties: {
      title:    { type: 'string', minLength: 1, maxLength: 200 },
      subtitle: { type: ['string', 'null'], maxLength: 200 },
      icon:     { type: ['string', 'null'], maxLength: 8, description: 'Single emoji or short character; iframe renders prefix to title' },
    },
  },
  initial_state: () => ({ title: 'Untitled', subtitle: null, icon: null }),
  validate: (state) => {
    if (typeof state.title !== 'string' || state.title.length === 0) {
      throw new Error('header.title must be a non-empty string');
    }
    if (state.title.length > 200) {
      throw new Error('header.title max 200 chars');
    }
  },
  actions: { setTitle, setSubtitle },
  queries: { title: titleQuery },
  a2ui_component: 'Heading',
};
