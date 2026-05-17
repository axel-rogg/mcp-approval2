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

/**
 * SEC-021: Allowlist URL-Schemes fuer href/src/formaction/action. Alle anderen
 * (javascript:, data:, vbscript:, file:, blob:, javascript&#58;) werden
 * silently zu '#' rewritten — Renderer haben damit eine Defense-in-Depth-Schicht
 * unabhaengig von ihrer eigenen URL-Validation.
 *
 * `https:` + `http:` + relative-paths (`/foo`, `./foo`, `foo`) sind erlaubt;
 * `mailto:`/`tel:` werden NICHT erlaubt — wenn ein Renderer das braucht,
 * setzt er das Attribut direkt mit eigener Validierung.
 */
const URL_ATTRS = new Set(['href', 'src', 'formaction', 'action', 'srcset', 'xlink:href']);
const DANGEROUS_SCHEME_RE = /^\s*(javascript|data|vbscript|file|blob|about|mocha):/i;

export function isSafeUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '') return false;
  if (DANGEROUS_SCHEME_RE.test(trimmed)) return false;
  // Hex/unicode-encoded scheme-injection (z.B. `&#x6A;avascript:`).
  // Wir reichern den Check um decoded-Vergleich an.
  try {
    const decoded = decodeURIComponent(trimmed);
    if (DANGEROUS_SCHEME_RE.test(decoded)) return false;
  } catch {
    // malformed-encoded URL → reject defensively
    return false;
  }
  return true;
}

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
      } else if (URL_ATTRS.has(k.toLowerCase())) {
        // SEC-021: silently neutralize javascript:/data:/file:/etc URLs.
        // Wir wuerfen nicht — Renderer sollen weiterhin compose, der Link
        // ist nur kaputt (href="#"), kein XSS.
        const raw = v === true ? '' : String(v);
        if (isSafeUrl(raw)) {
          node.setAttribute(k, raw);
        } else {
          // eslint-disable-next-line no-console
          console.warn(`[el] rejected unsafe URL for ${tag}.${k}: ${raw.slice(0, 60)}`);
          node.setAttribute(k, '#');
        }
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
