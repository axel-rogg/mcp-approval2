/**
 * Renderer fuer progress_ring block.
 *
 * State: { value: number; target: number; label?: string|null; caption?: string|null }
 * Actions: increment(by?), decrement(by?), setValue(value), setTarget(target), reset()
 */
import type { BlockRenderer, RenderArgs } from './types.js';
import { el, safeNumber, safeString, svgEl } from './types.js';

interface ProgressRingState {
  readonly value?: number;
  readonly target?: number;
  readonly label?: string | null;
  readonly caption?: string | null;
}

export const progressRingRenderer: BlockRenderer<ProgressRingState> = {
  type: 'progress_ring',
  render({ state, onAction }: RenderArgs<ProgressRingState>) {
    const value = safeNumber(state.value, 0);
    const target = Math.max(1, safeNumber(state.target, 100));
    const fraction = Math.max(0, Math.min(1, value / target));
    const label = safeString(state.label ?? undefined, '');
    const caption = safeString(state.caption ?? undefined, '');

    const radius = 40;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference * (1 - fraction);

    const ring = svgEl(
      'svg',
      { width: 100, height: 100, viewBox: '0 0 100 100', class: 'block-progress-ring-svg' },
      [
        svgEl('circle', {
          cx: 50,
          cy: 50,
          r: radius,
          fill: 'none',
          stroke: 'var(--border)',
          'stroke-width': 8,
        }),
        svgEl('circle', {
          cx: 50,
          cy: 50,
          r: radius,
          fill: 'none',
          stroke: 'var(--accent)',
          'stroke-width': 8,
          'stroke-linecap': 'round',
          'stroke-dasharray': String(circumference),
          'stroke-dashoffset': String(offset),
          transform: 'rotate(-90 50 50)',
        }),
        svgEl('text', {
          x: 50,
          y: 56,
          'text-anchor': 'middle',
          'font-size': 18,
          fill: 'currentColor',
          text: `${Math.round(fraction * 100)}%`,
        }),
      ],
    );

    async function dispatch(action: string, payload?: Record<string, unknown>): Promise<void> {
      try {
        await onAction(action, payload);
      } catch (e) {
        console.error('progress_ring dispatch', action, e);
      }
    }

    return el('div', { class: 'block block-progress-ring' }, [
      label ? el('div', { class: 'block-progress-label', text: label }) : null,
      ring,
      el('div', { class: 'block-progress-counts muted small', text: `${value} / ${target}` }),
      caption ? el('div', { class: 'block-progress-caption muted small', text: caption }) : null,
      el('div', { class: 'row block-progress-actions' }, [
        el('button', {
          type: 'button',
          class: 'btn btn-secondary btn-small',
          text: '−',
          onclick: () => void dispatch('decrement', { by: 1 }),
        }),
        el('button', {
          type: 'button',
          class: 'btn btn-small',
          text: '+',
          onclick: () => void dispatch('increment', { by: 1 }),
        }),
        el('button', {
          type: 'button',
          class: 'btn btn-secondary btn-small',
          text: 'Reset',
          onclick: () => void dispatch('reset', {}),
        }),
      ]),
    ]);
  },
};
