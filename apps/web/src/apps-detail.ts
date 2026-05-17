/**
 * Apps-Detail-View — single app with block rendering.
 *
 * Optimistic-Update-Pattern (2026-05-17):
 *   - Initial: GET /v1/apps/:id → render full layout
 *   - Per Action:
 *       1. POST /v1/apps/:id/invoke
 *       2. Apply returned `patches` lokal auf cached layout-state
 *       3. Re-render NUR den betroffenen Block (nicht den ganzen main-container)
 *   - Full reload nur bei error (CONCURRENT_UPDATE, NetErr, etc.).
 *
 * Vorteile: kein flicker, scroll-position bleibt, Eingabe-Felder in anderen
 * Bloecken (z.B. text_field) verlieren ihren Wert nicht.
 */
import { ApiError } from './api.js';
import type {
  ApiAppsClient,
  AppInstance,
  AppRead,
  InvokeResult,
  LayoutDoc,
} from './api-apps.js';
import { getRenderer } from './blocks/registry.js';
import { el } from './blocks/types.js';

function isLayoutDoc(v: unknown): v is LayoutDoc {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o['components']) && typeof o['state'] === 'object' && o['state'] !== null;
}

function buildAppTopbar(): { host: HTMLElement; setTitle: (title: string) => void } {
  const titleEl = el('h1', { class: 'app-detail-title', text: '' });
  const host = el('header', { class: 'topbar app-detail-topbar' }, [
    el('a', { href: '#/apps', class: 'app-back-link', text: '← Apps' }),
    titleEl,
  ]);
  return {
    host,
    setTitle(t: string) {
      titleEl.textContent = t;
    },
  };
}

function renderEmptyLayout(): HTMLElement {
  return el('div', { class: 'card' }, [
    el('p', {
      class: 'muted',
      text: 'Diese App hat noch keine Layout-Components. Layout wird ueblicherweise vom AI-Agent gesetzt.',
    }),
  ]);
}

/**
 * Apply JSON-Patch-like operation auf block-state. Patches sind block-relativ:
 *   - path='/items'  → state['items'] = value
 *   - path='/items/0/done' → state['items'][0]['done'] = value
 *   - path='' or '/' → state ersetzt komplett (root-replace)
 *
 * Mutiert das Object in-place (caller hat die copy).
 */
function applyBlockPatches(
  blockState: unknown,
  patches: ReadonlyArray<{ readonly path: string; readonly value: unknown }>,
): unknown {
  // Wenn blockState noch nicht initialisiert ist (z.B. neuer block): start with empty object.
  let state: Record<string, unknown> = (blockState && typeof blockState === 'object' && !Array.isArray(blockState))
    ? { ...(blockState as Record<string, unknown>) }
    : {};

  for (const p of patches) {
    const segs = p.path.split('/').filter(Boolean);
    if (segs.length === 0) {
      // Root-replace
      state = (p.value && typeof p.value === 'object' && !Array.isArray(p.value))
        ? { ...(p.value as Record<string, unknown>) }
        : ({} as Record<string, unknown>);
      continue;
    }
    // Walk to parent
    let cursor: Record<string, unknown> | unknown[] = state;
    for (let i = 0; i < segs.length - 1; i++) {
      const k = segs[i]!;
      const next = (cursor as Record<string, unknown>)[k];
      if (next === undefined || next === null) {
        // Auto-vivify: numeric next-key → array, sonst object
        const nextSeg = segs[i + 1]!;
        const created: unknown = /^\d+$/.test(nextSeg) ? [] : {};
        (cursor as Record<string, unknown>)[k] = created;
        cursor = created as Record<string, unknown> | unknown[];
      } else {
        cursor = next as Record<string, unknown> | unknown[];
      }
    }
    const lastKey = segs[segs.length - 1]!;
    if (Array.isArray(cursor) && /^\d+$/.test(lastKey)) {
      (cursor as unknown[])[Number(lastKey)] = p.value;
    } else {
      (cursor as Record<string, unknown>)[lastKey] = p.value;
    }
  }
  return state;
}

interface BlockContext {
  readonly node: HTMLElement;
  readonly blockType: string;
  readonly config: Record<string, unknown>;
}

interface AppDetailContext {
  readonly api: ApiAppsClient;
  readonly appId: string;
  layout: LayoutDoc;
  app: AppInstance;
  readonly blockNodes: Map<string, BlockContext>;
  readonly mainContainer: HTMLElement;
  fullReload: () => Promise<void>;
}

function renderBlock(
  ctx: AppDetailContext,
  blockId: string,
  blockType: string,
  blockState: unknown,
  config: Record<string, unknown>,
): HTMLElement | null {
  const renderer = getRenderer(blockType);
  if (!renderer) {
    console.warn('apps-detail: renderer missing for block', { blockId, blockType });
    return null;
  }

  const onAction = async (
    action: string,
    payload?: Record<string, unknown>,
  ): Promise<void> => {
    let res: InvokeResult;
    try {
      res = await ctx.api.invoke({
        id: ctx.appId,
        block_id: blockId,
        action,
        payload: payload ?? {},
      });
    } catch (err) {
      const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
      console.error('invoke failed', { blockId, action, err });
      alert('Action failed: ' + msg);
      return;
    }

    // Optimistic-Update: patches sind block-relativ. Wir mutieren den cached
    // layout-state und re-rendern NUR den affected block.
    const oldState = (ctx.layout.state as Record<string, unknown>)[blockId];
    const newState = applyBlockPatches(oldState, res.patches);
    (ctx.layout.state as Record<string, unknown>)[blockId] = newState;
    ctx.app = res.app;

    // Re-render nur diesen block.
    const bc = ctx.blockNodes.get(blockId);
    if (bc) {
      const fresh = buildBlockNode(ctx, blockId, bc.blockType, newState, bc.config);
      if (fresh) {
        bc.node.replaceWith(fresh);
        ctx.blockNodes.set(blockId, {
          node: fresh,
          blockType: bc.blockType,
          config: bc.config,
        });
      }
    }
  };

  const wrap = el('section', { class: 'card block-wrap', 'data-block-id': blockId });
  try {
    const node = renderer.render({
      blockId,
      state: blockState,
      config,
      onAction,
    });
    wrap.appendChild(node);
  } catch (e) {
    console.error('renderer threw', blockType, e);
    wrap.appendChild(
      el('p', {
        class: 'err',
        text: `Renderer fuer "${blockType}" fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`,
      }),
    );
  }
  return wrap;
}

function buildBlockNode(
  ctx: AppDetailContext,
  blockId: string,
  blockType: string,
  blockState: unknown,
  config: Record<string, unknown>,
): HTMLElement | null {
  return renderBlock(ctx, blockId, blockType, blockState, config);
}

export async function renderAppDetail(
  root: HTMLElement,
  api: ApiAppsClient,
  appId: string,
): Promise<void> {
  const main = el('main', { class: 'app-detail' });
  const { host: topbarHost, setTitle } = buildAppTopbar();
  root.replaceChildren(topbarHost, main);

  // Context wird beim ersten reload populiert.
  const ctx: AppDetailContext = {
    api,
    appId,
    layout: { version: 'v0.10', components: [], state: {} } as LayoutDoc,
    app: null as unknown as AppInstance,
    blockNodes: new Map(),
    mainContainer: main,
    fullReload: async () => {},
  };

  async function fullReload(): Promise<void> {
    main.replaceChildren(el('p', { class: 'muted', text: 'Lade App…' }));
    ctx.blockNodes.clear();
    let read: AppRead;
    try {
      read = await api.getApp(appId);
    } catch (err) {
      const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
      main.replaceChildren(
        el('div', { class: 'card' }, [
          el('p', { class: 'err', text: 'App konnte nicht geladen werden: ' + msg }),
          el('a', { href: '#/apps', class: 'btn btn-secondary', text: '← Zurueck zu Apps' }),
        ]),
      );
      return;
    }

    setTitle(read.app.title || read.app.id);
    ctx.app = read.app;
    main.replaceChildren();

    if (!isLayoutDoc(read.state)) {
      main.appendChild(renderEmptyLayout());
      return;
    }
    ctx.layout = read.state;
    if (ctx.layout.components.length === 0) {
      main.appendChild(renderEmptyLayout());
      return;
    }
    for (const comp of ctx.layout.components) {
      const blockState = (ctx.layout.state as Record<string, unknown>)[comp.id];
      const config = comp.config ?? {};
      const node = buildBlockNode(ctx, comp.id, comp.block, blockState, config);
      if (node) {
        main.appendChild(node);
        ctx.blockNodes.set(comp.id, { node, blockType: comp.block, config });
      }
    }
  }

  ctx.fullReload = fullReload;
  await fullReload();
}
