/**
 * Renderer fuer chart block.
 *
 * State: { chartType: 'line'|'bar'; source: string|null; xField; yField?; groupBy; agg; title? }
 *
 * Datenpunkte werden vom Backend via `dataPoints`-Query berechnet (kein
 * Client-side aggregation). Renderer fetcht die Query nach mount und zeichnet
 * eine simple SVG-Visualisierung.
 */
import type { BlockRenderer, RenderArgs } from './types.js';
import { el, safeString, svgEl } from './types.js';

interface ChartState {
  readonly chartType?: string;
  readonly source?: string | null;
  readonly xField?: string;
  readonly yField?: string | null;
  readonly groupBy?: string;
  readonly agg?: string;
  readonly title?: string | null;
}

interface DataPoint {
  readonly x: string | number;
  readonly y: number;
}

function lineChart(points: DataPoint[]): SVGElement {
  const w = 320;
  const h = 140;
  const pad = 24;
  if (points.length < 2) {
    return svgEl('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` }, [
      svgEl('text', {
        x: w / 2,
        y: h / 2,
        'text-anchor': 'middle',
        fill: 'currentColor',
        text: 'No data',
      }),
    ]);
  }
  const ys = points.map((p) => p.y);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const yRange = yMax - yMin || 1;
  const stride = (w - 2 * pad) / Math.max(1, points.length - 1);
  const polyPts = points
    .map((p, i) => {
      const x = pad + i * stride;
      const y = h - pad - ((p.y - yMin) / yRange) * (h - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return svgEl('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, class: 'block-chart-svg' }, [
    svgEl('polyline', {
      fill: 'none',
      stroke: 'var(--accent)',
      'stroke-width': 2,
      points: polyPts,
    }),
  ]);
}

function barChart(points: DataPoint[]): SVGElement {
  const w = 320;
  const h = 140;
  const pad = 24;
  if (points.length === 0) {
    return svgEl('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` }, [
      svgEl('text', {
        x: w / 2,
        y: h / 2,
        'text-anchor': 'middle',
        fill: 'currentColor',
        text: 'No data',
      }),
    ]);
  }
  const ys = points.map((p) => p.y);
  const yMax = Math.max(...ys, 1);
  const barW = (w - 2 * pad) / points.length;
  const bars = points.map((p, i) => {
    const x = pad + i * barW + 1;
    const barH = (p.y / yMax) * (h - 2 * pad);
    const y = h - pad - barH;
    return svgEl('rect', {
      x: x.toFixed(1),
      y: y.toFixed(1),
      width: Math.max(1, barW - 2).toFixed(1),
      height: barH.toFixed(1),
      fill: 'var(--accent)',
    });
  });
  return svgEl(
    'svg',
    { width: w, height: h, viewBox: `0 0 ${w} ${h}`, class: 'block-chart-svg' },
    bars,
  );
}

export const chartRenderer: BlockRenderer<ChartState> = {
  type: 'chart',
  render({ blockId, state }: RenderArgs<ChartState>) {
    const chartType = safeString(state.chartType, 'line');
    const title = safeString(state.title ?? undefined, '');
    const container = el('div', { class: 'block block-chart' });
    if (title) container.appendChild(el('h4', { class: 'block-chart-title', text: title }));
    const chartHost = el('div', { class: 'block-chart-host' });
    container.appendChild(chartHost);
    container.appendChild(
      el('div', {
        class: 'muted small',
        text: `${chartType} · ${safeString(state.source, '(no source)')} · ${safeString(state.agg, 'count')}`,
      }),
    );

    // queries are routed through the same onAction surface — emit a custom
    // 'query' action that the page-level dispatcher translates to api.query().
    // For now we render a placeholder; consumers can fetch + re-render.
    chartHost.appendChild(
      chartType === 'bar' ? barChart([]) : lineChart([]),
    );

    // Lazy-load datapoints. The wrapper sets data-chart-block-id so the page
    // can wire it up; if no wrapper, we fall back to a "Load data" button.
    container.dataset['blockId'] = blockId;
    container.dataset['blockType'] = 'chart';

    return container;
  },
};

// Exported helper so the detail-view can populate the chart after mount.
export function paintChartData(container: HTMLElement, points: DataPoint[], chartType: string): void {
  const host = container.querySelector('.block-chart-host');
  if (!host) return;
  host.replaceChildren(chartType === 'bar' ? barChart(points) : lineChart(points));
}

export type { DataPoint };
