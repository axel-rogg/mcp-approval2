/**
 * Block-Renderer Types — gemeinsames Interface fuer Frontend-Renderer.
 *
 * Pendant zu apps/server/src/apps/blocks/types.ts. Backend definiert
 * actions/queries/state-schema, Frontend definiert das visual rendering.
 *
 * Renderer sind pure-DOM: keine Frameworks, kein virtual-DOM. Sie bauen
 * HTMLElements mit Event-Handlern und geben sie zurueck.
 */

export type ActionDispatch = (action: string, payload?: Record<string, unknown>) => Promise<void>;

export interface RenderArgs<State = unknown> {
  readonly blockId: string;
  readonly state: State;
  readonly config: Record<string, unknown>;
  readonly onAction: ActionDispatch;
}

export interface BlockRenderer<State = unknown> {
  readonly type: string;
  render(args: RenderArgs<State>): HTMLElement;
}

// ---------------------------------------------------------------------------
// DOM-Helpers (intern fuer Renderer)
// ---------------------------------------------------------------------------

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | number | boolean | EventListener | undefined>,
  children?: ReadonlyArray<Node | string | null | undefined>,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = String(v);
      else if (k === 'text') node.textContent = String(v);
      else if (k === 'html') node.innerHTML = String(v);
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else {
        node.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }
  if (children) {
    for (const c of children) {
      if (c === null || c === undefined) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  }
  return node;
}

/** SVG-Variante (HTMLElement-API kann SVG nicht via createElement). */
export function svgEl(
  tag: string,
  attrs?: Record<string, string | number | boolean | EventListener | undefined>,
  children?: ReadonlyArray<Node | string | null | undefined>,
): SVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') node.textContent = String(v);
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else {
        node.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }
  if (children) {
    for (const c of children) {
      if (c === null || c === undefined) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  }
  return node;
}

export function safeNumber(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return fallback;
}

export function safeString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  return fallback;
}

export function safeArray<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export function safeBool(v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') return v;
  return fallback;
}
