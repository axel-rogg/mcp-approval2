/**
 * Timer-Block — generic countdown timer mit start/stop/complete-Lifecycle.
 */
import type { BlockDef, BlockActionDef, BlockQueryDef } from './types.js';

const MIN_DURATION = 1;
const MAX_DURATION = 86_400;

export type TimerStatus = 'idle' | 'running' | 'paused' | 'done';

export interface TimerState {
  duration_seconds: number;
  status: TimerStatus;
  started_at: number | null;
  paused_at_seconds: number | null;
  last_completed_at: number | null;
  last_run_seconds: number | null;
}

const start: BlockActionDef<TimerState, { duration_seconds?: number }> = {
  name: 'start',
  description: 'Start the timer.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      duration_seconds: { type: 'integer', minimum: MIN_DURATION, maximum: MAX_DURATION },
    },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Timer → start',
  handler: (state, payload) => {
    if (state.status === 'running') {
      throw new Error(`timer already running`);
    }
    const duration = payload.duration_seconds ?? state.duration_seconds;
    if (duration < MIN_DURATION || duration > MAX_DURATION) {
      throw new Error(`timer.duration_seconds out of range`);
    }
    const now = Date.now();
    return {
      patches: [
        { path: '/duration_seconds', value: duration },
        { path: '/status', value: 'running' as TimerStatus },
        { path: '/started_at', value: now },
        { path: '/paused_at_seconds', value: null },
      ],
      result: { duration_seconds: duration, started_at_ms: now },
    };
  },
};

const pause: BlockActionDef<TimerState, Record<string, never>> = {
  name: 'pause',
  description: 'Pause a running timer.',
  payload_schema: { type: 'object', additionalProperties: false },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Timer → pause',
  handler: (state) => {
    if (state.status !== 'running' || state.started_at == null) {
      return { patches: [] };
    }
    const elapsed = Math.max(0, Math.floor((Date.now() - state.started_at) / 1000));
    return {
      patches: [
        { path: '/status', value: 'paused' as TimerStatus },
        { path: '/paused_at_seconds', value: elapsed },
        { path: '/started_at', value: null },
      ],
      result: { paused_at_seconds: elapsed },
    };
  },
};

const resume: BlockActionDef<TimerState, Record<string, never>> = {
  name: 'resume',
  description: 'Resume a paused timer.',
  payload_schema: { type: 'object', additionalProperties: false },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Timer → resume',
  handler: (state) => {
    if (state.status !== 'paused') {
      return { patches: [] };
    }
    const elapsed = state.paused_at_seconds ?? 0;
    const now = Date.now();
    return {
      patches: [
        { path: '/status', value: 'running' as TimerStatus },
        { path: '/started_at', value: now - elapsed * 1000 },
        { path: '/paused_at_seconds', value: null },
      ],
      result: { resumed_at_ms: now, elapsed_at_resume: elapsed },
    };
  },
};

const stop: BlockActionDef<TimerState, Record<string, never>> = {
  name: 'stop',
  description: 'Stop a running timer without recording completion.',
  payload_schema: { type: 'object', additionalProperties: false },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Timer → stop',
  handler: (state) => {
    if (state.status !== 'running' && state.status !== 'paused') {
      return { patches: [] };
    }
    return {
      patches: [
        { path: '/status', value: 'idle' as TimerStatus },
        { path: '/started_at', value: null },
        { path: '/paused_at_seconds', value: null },
      ],
    };
  },
};

const complete: BlockActionDef<TimerState, Record<string, never>> = {
  name: 'complete',
  description: 'Mark timer as completed.',
  payload_schema: { type: 'object', additionalProperties: false },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Timer → complete',
  handler: (state) => {
    if (state.status === 'done') {
      return {
        patches: [],
        result: {
          last_run_seconds: state.last_run_seconds ?? state.duration_seconds,
          completed_at_ms: state.last_completed_at ?? 0,
          already_done: true,
        },
      };
    }
    if (state.status === 'paused') {
      const now = Date.now();
      const elapsed = state.paused_at_seconds ?? state.duration_seconds;
      return {
        patches: [
          { path: '/status', value: 'done' as TimerStatus },
          { path: '/started_at', value: null },
          { path: '/paused_at_seconds', value: null },
          { path: '/last_completed_at', value: now },
          { path: '/last_run_seconds', value: elapsed },
        ],
        result: { last_run_seconds: elapsed, completed_at_ms: now },
      };
    }
    if (state.status !== 'running' || state.started_at == null) {
      const now = Date.now();
      return {
        patches: [
          { path: '/status', value: 'done' as TimerStatus },
          { path: '/started_at', value: null },
          { path: '/paused_at_seconds', value: null },
          { path: '/last_completed_at', value: now },
          { path: '/last_run_seconds', value: state.duration_seconds },
        ],
        result: { last_run_seconds: state.duration_seconds, completed_at_ms: now },
      };
    }
    const now = Date.now();
    const elapsed = Math.max(1, Math.floor((now - state.started_at) / 1000));
    return {
      patches: [
        { path: '/status', value: 'done' as TimerStatus },
        { path: '/started_at', value: null },
        { path: '/paused_at_seconds', value: null },
        { path: '/last_completed_at', value: now },
        { path: '/last_run_seconds', value: elapsed },
      ],
      result: { last_run_seconds: elapsed, completed_at_ms: now },
    };
  },
};

const reset: BlockActionDef<TimerState, Record<string, never>> = {
  name: 'reset',
  description: 'Reset timer to idle state.',
  payload_schema: { type: 'object', additionalProperties: false },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Timer → reset',
  handler: () => ({
    patches: [
      { path: '/status', value: 'idle' as TimerStatus },
      { path: '/started_at', value: null },
      { path: '/paused_at_seconds', value: null },
    ],
  }),
};

const setDuration: BlockActionDef<TimerState, { duration_seconds: number }> = {
  name: 'setDuration',
  description: 'Change the configured duration.',
  payload_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['duration_seconds'],
    properties: {
      duration_seconds: { type: 'integer', minimum: MIN_DURATION, maximum: MAX_DURATION },
    },
  },
  sensitivity: 'approval',
  iframe_auto_approve: true,
  approval_display_template: 'Timer → set duration to {{payload.duration_seconds}}s',
  handler: (state, payload) => {
    if (state.status === 'running') {
      throw new Error('timer.setDuration not allowed while running');
    }
    return { patches: [{ path: '/duration_seconds', value: payload.duration_seconds }] };
  },
};

const isRunningQuery: BlockQueryDef<TimerState, Record<string, never>, boolean> = {
  name: 'isRunning',
  description: 'Returns true if status === "running".',
  returns_schema: { type: 'boolean' },
  compute: (state) => state.status === 'running',
};

const statusQuery: BlockQueryDef<TimerState, Record<string, never>, TimerStatus> = {
  name: 'status',
  description: 'Returns the current state-machine status.',
  returns_schema: { type: 'string', enum: ['idle', 'running', 'paused', 'done'] },
  compute: (state) => state.status,
};

const durationQuery: BlockQueryDef<TimerState, Record<string, never>, number> = {
  name: 'duration',
  description: 'Returns configured duration in seconds.',
  returns_schema: { type: 'integer', minimum: MIN_DURATION },
  compute: (state) => state.duration_seconds,
};

const elapsedSecondsQuery: BlockQueryDef<TimerState, Record<string, never>, number> = {
  name: 'elapsedSeconds',
  description: 'Seconds since started_at.',
  returns_schema: { type: 'integer', minimum: 0 },
  compute: (state) => {
    if (state.status === 'paused') return state.paused_at_seconds ?? 0;
    if (state.status !== 'running' || state.started_at == null) return 0;
    return Math.max(0, Math.floor((Date.now() - state.started_at) / 1000));
  },
};

const remainingSecondsQuery: BlockQueryDef<TimerState, Record<string, never>, number> = {
  name: 'remainingSeconds',
  description: 'Seconds remaining.',
  returns_schema: { type: 'integer', minimum: 0 },
  compute: (state) => {
    if (state.status === 'paused') {
      return Math.max(0, state.duration_seconds - (state.paused_at_seconds ?? 0));
    }
    if (state.status !== 'running' || state.started_at == null) return state.duration_seconds;
    const elapsed = Math.floor((Date.now() - state.started_at) / 1000);
    return Math.max(0, state.duration_seconds - elapsed);
  },
};

const lastRunQuery: BlockQueryDef<
  TimerState,
  Record<string, never>,
  { completed_at: number; seconds: number } | null
> = {
  name: 'lastRun',
  description: 'Last completion summary or null.',
  returns_schema: {
    type: ['object', 'null'],
    properties: {
      completed_at: { type: 'integer' },
      seconds: { type: 'integer' },
    },
  },
  compute: (state) => {
    if (state.last_completed_at == null || state.last_run_seconds == null) return null;
    return { completed_at: state.last_completed_at, seconds: state.last_run_seconds };
  },
};

export const timerBlock: BlockDef<TimerState> = {
  type: 'timer',
  description: 'Countdown timer with start/stop/complete state-machine.',
  state_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['duration_seconds', 'status'],
    properties: {
      duration_seconds: { type: 'integer', minimum: MIN_DURATION, maximum: MAX_DURATION },
      status: { type: 'string', enum: ['idle', 'running', 'paused', 'done'] },
      started_at: { type: ['integer', 'null'], minimum: 0 },
      paused_at_seconds: { type: ['integer', 'null'], minimum: 0 },
      last_completed_at: { type: ['integer', 'null'], minimum: 0 },
      last_run_seconds: { type: ['integer', 'null'], minimum: 1 },
    },
  },
  initial_state: () => ({
    duration_seconds: 600,
    status: 'idle',
    started_at: null,
    paused_at_seconds: null,
    last_completed_at: null,
    last_run_seconds: null,
  }),
  validate: (state) => {
    if (typeof state.duration_seconds !== 'number' || !Number.isInteger(state.duration_seconds)) {
      throw new Error('timer.duration_seconds must be an integer');
    }
    if (state.duration_seconds < MIN_DURATION || state.duration_seconds > MAX_DURATION) {
      throw new Error(`timer.duration_seconds out of range`);
    }
    if (!['idle', 'running', 'paused', 'done'].includes(state.status)) {
      throw new Error(`timer.status invalid`);
    }
    if (state.status === 'running' && state.started_at == null) {
      throw new Error('timer.started_at must be set when status=running');
    }
    if (state.status === 'paused' && state.paused_at_seconds == null) {
      throw new Error('timer.paused_at_seconds must be set when status=paused');
    }
  },
  actions: { start, stop, pause, resume, complete, reset, setDuration },
  queries: {
    isRunning: isRunningQuery,
    status: statusQuery,
    duration: durationQuery,
    elapsedSeconds: elapsedSecondsQuery,
    remainingSeconds: remainingSecondsQuery,
    lastRun: lastRunQuery,
  },
  a2ui_component: 'Timer',
};
