/**
 * Renderer fuer stat_card block.
 *
 * State: { value: number; label?: string|null; delta?: number|null; sparkline?: number[]; unit?: string|null }
 */
import type { BlockRenderer, RenderArgs } from './types.js';
import { el, safeNumber, safeString, safeArray, svgEl } from './types.js';

interface StatCardState {
  readonly value?: number;
  readonly label?: string | null;
  readonly delta?: number | null;
  readonly sparkline?: number[];
  readonly unit?: string | null;
}

function sparklineSvg(values: number[]): SVGElement {
  const w = 120;
  const h = 32;
  if (values.length < 2) {
    return svgEl('svg', {
      width: w,
      height: h,
      viewBox: `0 0 ${w} ${h}`,
      class: 'block-stat-sparkline',
    });
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return svgEl(
    'svg',
    { width: w, height: h, viewBox: `0 0 ${w} ${h}`, class: 'block-stat-sparkline' },
    [
      svgEl('polyline', {
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.5,
        points: pts,
      }),
    ],
  );
}

export const statCardRenderer: BlockRenderer<StatCardState> = {
  type: 'stat_card',
  render({ state }: RenderArgs<StatCardState>) {
    const value = safeNumber(state.value, 0);
    const label = safeString(state.label ?? undefined, '');
    const unit = safeString(state.unit ?? undefined, '');
    const delta = typeof state.delta === 'number' ? state.delta : null;
    const sparkline = safeArray<number>(state.sparkline).filter((v) => typeof v === 'number');

    const deltaEl =
      delta !== null
        ? el('span', {
            class: 'block-stat-delta ' + (delta >= 0 ? 'ok' : 'err'),
            text: (delta >= 0 ? '+' : '') + String(delta),
          })
        : null;

    return el('div', { class: 'block block-stat-card' }, [
      label ? el('div', { class: 'block-stat-label muted small', text: label }) : null,
      el('div', { class: 'block-stat-row' }, [
        el('span', { class: 'block-stat-value', text: String(value) }),
        unit ? el('span', { class: 'block-stat-unit muted', text: unit }) : null,
        deltaEl,
      ]),
      sparkline.length >= 2 ? sparklineSvg(sparkline) : null,
    ]);
  },
};
