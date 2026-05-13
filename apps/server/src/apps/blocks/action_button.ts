/**
 * ActionButton-Block — konfigurierbarer Trigger mit kind-Discriminator.
 *
 * Drei Kinds:
 *   prompt  → Text wird an Claude/User gesendet (Replay-Konversation)
 *   url     → Worker antwortet mit redirect-instruction; iframe-bridge oeffnet URL
 *   tool    → Worker invoked das in payload.tool_id genannte MCP-Tool mit args
 *
 * State enthaelt ALLE Trigger-Config (label + kind + payload). Action.trigger
 * hat empty payload — der Click feuert die preconfigured action ab.
 */
import type { BlockDef, BlockActionDef } from './types.js';

export type ActionButtonKind = 'prompt' | 'url' | 'tool';

export interface ActionButtonState {
  label: string;
  kind: ActionButtonKind;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>;
}

const URL_PATTERN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i;

function validatePayload(state: ActionButtonState): void {
  const p = state.payload;
  if (state.kind === 'prompt') {
    if (typeof p['text'] !== 'string' || p['text'].length === 0) {
      throw new Error('action_button kind=prompt requires payload.text (non-empty string)');
    }
    if (p['text'].length > 4000) {
      throw new Error('action_button payload.text max 4000 chars');
    }
  } else if (state.kind === 'url') {
    if (typeof p['href'] !== 'string' || p['href'].length === 0) {
      throw new Error('action_button kind=url requires payload.href');
    }
    if (!URL_PATTERN.test(p['href'])) {
      throw new Error(`action_button payload.href must start with https:// (got "${String(p['href']).slice(0, 40)}")`);
    }
  } else if (state.kind === 'tool') {
    if (typeof p['tool_id'] !== 'string' || p['tool_id'].length === 0) {
      throw new Error('action_button kind=tool requires payload.tool_id');
    }
    if (p['args'] !== undefined && (typeof p['args'] !== 'object' || p['args'] === null || Array.isArray(p['args']))) {
      throw new Error('action_button kind=tool payload.args must be a JSON object if present');
    }
  } else {
    throw new Error(`action_button.kind must be prompt|url|tool (got "${state.kind}")`);
  }
}

const trigger: BlockActionDef<ActionButtonState, Record<string, never>> = {
  name: 'trigger',
  description: 'Fire the preconfigured trigger (prompt/url/tool). Click-event from iframe.',
  payload_schema: { type: 'object', additionalProperties: false, properties: {} },
  sensitivity: 'approval',
  approval_display_template: 'Trigger button "{{current_state.label}}" ({{current_state.kind}})',
  handler: (state) => {
    validatePayload(state);
    return {
      patches: [],
      result: { kind: state.kind, payload: state.payload },
    };
  },
};

const setLabel: BlockActionDef<ActionButtonState, { label: string }> = {
  name: 'setLabel',
  description: 'Rename the button label.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['label'],
    properties: { label: { type: 'string', minLength: 1, maxLength: 100 } },
  },
  sensitivity: 'approval',
  approval_display_template: 'Button → rename to "{{payload.label}}"',
  handler: (_state, payload) => ({
    patches: [{ path: '/label', value: payload.label }],
  }),
};

export const actionButtonBlock: BlockDef<ActionButtonState> = {
  type: 'action_button',
  description: 'A single button that triggers a preconfigured prompt-replay, URL-open, or MCP-tool-invocation.',
  state_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['label', 'kind', 'payload'],
    properties: {
      label: { type: 'string', minLength: 1, maxLength: 100 },
      kind: { enum: ['prompt', 'url', 'tool'] },
      payload: { type: 'object' },
    },
  },
  initial_state: () => ({
    label: 'Untitled button',
    kind: 'prompt',
    payload: { text: 'Hello from action_button' },
  }),
  validate: validatePayload,
  actions: { trigger, setLabel },
  queries: {},
  a2ui_component: 'Button',
};
