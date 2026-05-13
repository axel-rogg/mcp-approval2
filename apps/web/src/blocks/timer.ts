/**
 * Renderer fuer timer block.
 *
 * State: { duration_seconds, status, started_at, paused_at_seconds, last_completed_at, last_run_seconds }
 * Status: 'idle' | 'running' | 'paused' | 'done'
 * Actions: start, pause, resume, stop, complete, reset, setDuration
 */
import type { BlockRenderer, RenderArgs } from './types.js';
import { el, safeNumber, safeString } from './types.js';

interface TimerState {
  readonly duration_seconds?: number;
  readonly status?: string;
  readonly started_at?: number | null;
  readonly paused_at_seconds?: number | null;
  readonly last_completed_at?: number | null;
  readonly last_run_seconds?: number | null;
}

function fmtMmSs(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function computeRemaining(s: TimerState): number {
  const duration = safeNumber(s.duration_seconds, 0);
  const status = safeString(s.status, 'idle');
  if (status === 'idle') return duration;
  if (status === 'done') return 0;
  if (status === 'paused') {
    const paused = safeNumber(s.paused_at_seconds, 0);
    return Math.max(0, duration - paused);
  }
  // running
  const startedAt = safeNumber(s.started_at, 0);
  const elapsed = (Date.now() - startedAt) / 1000;
  return Math.max(0, duration - elapsed);
}

export const timerRenderer: BlockRenderer<TimerState> = {
  type: 'timer',
  render({ state, onAction }: RenderArgs<TimerState>) {
    const status = safeString(state.status, 'idle');
    const duration = safeNumber(state.duration_seconds, 0);

    const display = el('div', { class: 'block-timer-display', text: fmtMmSs(computeRemaining(state)) });
    const statusEl = el('div', { class: 'muted small block-timer-status', text: status });

    let tickHandle: number | null = null;
    if (status === 'running') {
      tickHandle = window.setInterval(() => {
        const remaining = computeRemaining(state);
        display.textContent = fmtMmSs(remaining);
        if (remaining <= 0 && tickHandle !== null) {
          window.clearInterval(tickHandle);
          tickHandle = null;
        }
      }, 1000);
      // Best-effort cleanup: when block-renderer is replaced, the old display
      // is GC-rooted but no DOM-observer here. Caller (renderAppDetail) clears
      // the container so interval becomes orphaned; we clear via MutationObserver
      // on the container.
      const cleanup = (): void => {
        if (tickHandle !== null) {
          window.clearInterval(tickHandle);
          tickHandle = null;
        }
      };
      // detach on next render via custom DOM-event from container
      display.addEventListener('block-cleanup', cleanup);
    }

    async function dispatch(action: string, payload?: Record<string, unknown>): Promise<void> {
      try {
        await onAction(action, payload);
      } catch (e) {
        console.error('timer dispatch', action, e);
      }
    }

    const buttons: HTMLElement[] = [];
    if (status === 'idle' || status === 'done') {
      buttons.push(
        el('button', {
          type: 'button',
          class: 'btn btn-small',
          text: 'Start',
          onclick: () => void dispatch('start', {}),
        }),
      );
    }
    if (status === 'running') {
      buttons.push(
        el('button', {
          type: 'button',
          class: 'btn btn-secondary btn-small',
          text: 'Pause',
          onclick: () => void dispatch('pause', {}),
        }),
        el('button', {
          type: 'button',
          class: 'btn btn-small',
          text: 'Stop',
          onclick: () => void dispatch('stop', {}),
        }),
      );
    }
    if (status === 'paused') {
      buttons.push(
        el('button', {
          type: 'button',
          class: 'btn btn-small',
          text: 'Resume',
          onclick: () => void dispatch('resume', {}),
        }),
        el('button', {
          type: 'button',
          class: 'btn btn-secondary btn-small',
          text: 'Reset',
          onclick: () => void dispatch('reset', {}),
        }),
      );
    }

    return el('div', { class: 'block block-timer' }, [
      display,
      statusEl,
      el('div', { class: 'muted small', text: `Duration: ${fmtMmSs(duration)}` }),
      el('div', { class: 'row block-timer-actions' }, buttons),
    ]);
  },
};
