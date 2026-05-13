/**
 * Renderer fuer counter block.
 *
 * State: { value: number; target?: number|null; lastReset?: number|null }
 * Actions: increment(by?), decrement(by?), setValue(value), reset()
 */
import type { BlockRenderer, RenderArgs } from './types.js';
import { el, safeNumber } from './types.js';

interface CounterState {
  readonly value?: number;
  readonly target?: number | null;
  readonly lastReset?: number | null;
}

export const counterRenderer: BlockRenderer<CounterState> = {
  type: 'counter',
  render({ state, onAction }: RenderArgs<CounterState>) {
    const value = safeNumber(state.value, 0);
    const target = typeof state.target === 'number' ? state.target : null;

    const valueEl = el('div', {
      class: 'block-counter-value',
      text: String(value),
    });

    const progress =
      target && target > 0
        ? el('div', {
            class: 'block-counter-progress muted small',
            text: `${value} / ${target}`,
          })
        : null;

    async function dispatch(action: string, payload?: Record<string, unknown>): Promise<void> {
      try {
        await onAction(action, payload);
      } catch (e) {
        console.error('counter dispatch', action, e);
      }
    }

    const minusBtn = el('button', {
      type: 'button',
      class: 'btn btn-secondary btn-small',
      text: '−',
      onclick: () => void dispatch('decrement', { by: 1 }),
    });
    const plusBtn = el('button', {
      type: 'button',
      class: 'btn btn-small',
      text: '+',
      onclick: () => void dispatch('increment', { by: 1 }),
    });
    const resetBtn = el('button', {
      type: 'button',
      class: 'btn btn-secondary btn-small',
      text: 'Reset',
      onclick: () => void dispatch('reset', {}),
    });

    return el('div', { class: 'block block-counter' }, [
      valueEl,
      progress,
      el('div', { class: 'row block-counter-actions' }, [minusBtn, plusBtn, resetBtn]),
    ]);
  },
};
