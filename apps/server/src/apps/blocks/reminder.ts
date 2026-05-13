/**
 * Reminder-Block — Schedule-fähige Hinweise pro App.
 */
import type { BlockDef, BlockActionDef, BlockQueryDef } from './types.js';

const MAX_ENTRIES = 16;
const CRON_RE = /^(\*|[0-9,\-/*]+)\s+(\*|[0-9,\-/*]+)\s+(\*|[0-9,\-/*]+)\s+(\*|[0-9,\-/*]+)\s+(\*|[0-9,\-/*]+)$/;

export interface ReminderEntry {
  id: string;
  cron: string;
  message: string;
  enabled: boolean;
  last_fired?: number | null;
  channels?: string[];
}

export interface ReminderState {
  entries: ReminderEntry[];
}

function genId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

const addEntry: BlockActionDef<ReminderState, { cron: string; message: string; channels?: string[] }> = {
  name: 'addEntry',
  description: 'Add a new reminder.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['cron', 'message'],
    properties: {
      cron: { type: 'string', minLength: 9, maxLength: 64 },
      message: { type: 'string', minLength: 1, maxLength: 200 },
      channels: { type: 'array', items: { type: 'string', enum: ['push', 'in_app'] }, maxItems: 2 },
    },
  },
  sensitivity: 'approval',
  approval_display_template: 'Reminder + "{{payload.message}}" @ {{payload.cron}}',
  handler: (state, payload) => {
    if (!CRON_RE.test(payload.cron)) {
      throw new Error(`invalid cron "${payload.cron}"`);
    }
    if (state.entries.length >= MAX_ENTRIES) {
      throw new Error(`max ${MAX_ENTRIES} reminders per block`);
    }
    const entry: ReminderEntry = {
      id: genId(),
      cron: payload.cron,
      message: payload.message,
      enabled: true,
      last_fired: null,
      channels: payload.channels ?? ['push'],
    };
    return {
      patches: [{ path: '/entries', value: [...state.entries, entry] }],
      result: { id: entry.id },
    };
  },
};

const updateEntry: BlockActionDef<ReminderState, { id: string; cron?: string; message?: string }> = {
  name: 'updateEntry',
  description: 'Update cron or message of an existing reminder.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'string', minLength: 1 },
      cron: { type: 'string', minLength: 9, maxLength: 64 },
      message: { type: 'string', minLength: 1, maxLength: 200 },
    },
  },
  sensitivity: 'approval',
  approval_display_template: 'Reminder {{payload.id}} → update',
  handler: (state, payload) => {
    const idx = state.entries.findIndex((e) => e.id === payload.id);
    if (idx < 0) throw new Error(`reminder "${payload.id}" not found`);
    if (payload.cron && !CRON_RE.test(payload.cron)) {
      throw new Error(`invalid cron "${payload.cron}"`);
    }
    const updated: ReminderEntry = {
      ...state.entries[idx]!,
      ...(payload.cron ? { cron: payload.cron } : {}),
      ...(payload.message ? { message: payload.message } : {}),
    };
    const next = [...state.entries];
    next[idx] = updated;
    return { patches: [{ path: '/entries', value: next }] };
  },
};

const removeEntry: BlockActionDef<ReminderState, { id: string }> = {
  name: 'removeEntry',
  description: 'Remove a reminder permanently.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string', minLength: 1 } },
  },
  sensitivity: 'approval',
  approval_display_template: 'Reminder {{payload.id}} → delete',
  handler: (state, payload) => {
    const next = state.entries.filter((e) => e.id !== payload.id);
    if (next.length === state.entries.length) {
      throw new Error(`reminder "${payload.id}" not found`);
    }
    return { patches: [{ path: '/entries', value: next }] };
  },
};

const setEnabled: BlockActionDef<ReminderState, { id: string; enabled: boolean }> = {
  name: 'setEnabled',
  description: 'Pause/resume a reminder.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'enabled'],
    properties: {
      id: { type: 'string', minLength: 1 },
      enabled: { type: 'boolean' },
    },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Reminder {{payload.id}} → enabled={{payload.enabled}}',
  handler: (state, payload) => {
    const idx = state.entries.findIndex((e) => e.id === payload.id);
    if (idx < 0) throw new Error(`reminder "${payload.id}" not found`);
    const next = [...state.entries];
    next[idx] = { ...next[idx]!, enabled: payload.enabled };
    return { patches: [{ path: '/entries', value: next }] };
  },
};

const markFired: BlockActionDef<ReminderState, { id: string; ts?: number }> = {
  name: 'markFired',
  description: 'Stamp last_fired.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'string', minLength: 1 },
      ts: { type: 'integer', minimum: 0 },
    },
  },
  sensitivity: 'approval',
  approval_display_template: 'Reminder {{payload.id}} fired',
  handler: (state, payload) => {
    const idx = state.entries.findIndex((e) => e.id === payload.id);
    if (idx < 0) throw new Error(`reminder "${payload.id}" not found`);
    const next = [...state.entries];
    next[idx] = { ...next[idx]!, last_fired: payload.ts ?? Date.now() };
    return { patches: [{ path: '/entries', value: next }] };
  },
};

const listEntries: BlockQueryDef<ReminderState, Record<string, never>, ReminderEntry[]> = {
  name: 'listEntries',
  description: 'Returns all reminder entries.',
  compute: (state) => state.entries,
};

const enabledCount: BlockQueryDef<ReminderState, Record<string, never>, number> = {
  name: 'enabledCount',
  description: 'Count of enabled reminders.',
  returns_schema: { type: 'integer', minimum: 0 },
  compute: (state) => state.entries.filter((e) => e.enabled).length,
};

export const reminderBlock: BlockDef<ReminderState> = {
  type: 'reminder',
  description: 'Schedule-faehige Hinweise (cron-string + message).',
  state_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['entries'],
    properties: {
      entries: {
        type: 'array',
        maxItems: MAX_ENTRIES,
        items: {
          type: 'object',
          required: ['id', 'cron', 'message', 'enabled'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 32 },
            cron: { type: 'string', minLength: 9, maxLength: 64 },
            message: { type: 'string', minLength: 1, maxLength: 200 },
            enabled: { type: 'boolean' },
            last_fired: { type: ['integer', 'null'], minimum: 0 },
            channels: { type: 'array', items: { type: 'string', enum: ['push', 'in_app'] } },
          },
        },
      },
    },
  },
  initial_state: () => ({ entries: [] }),
  validate: (state) => {
    if (!Array.isArray(state.entries)) throw new Error('reminder.entries must be array');
    if (state.entries.length > MAX_ENTRIES) throw new Error(`reminder.entries max ${MAX_ENTRIES}`);
    const ids = new Set<string>();
    for (const e of state.entries) {
      if (ids.has(e.id)) throw new Error(`reminder duplicate id "${e.id}"`);
      ids.add(e.id);
      if (!CRON_RE.test(e.cron)) throw new Error(`reminder invalid cron "${e.cron}"`);
    }
  },
  actions: { addEntry, updateEntry, removeEntry, setEnabled, markFired },
  queries: { listEntries, enabledCount },
  a2ui_component: 'Reminder',
};
