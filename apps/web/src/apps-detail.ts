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
import type { ApiStorageClient, KnowledgeObjectRefs, RefView } from './api-storage.js';
import { getRenderer } from './blocks/registry.js';
import { el } from './blocks/types.js';

function isLayoutDoc(v: unknown): v is LayoutDoc {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o['components']) && typeof o['state'] === 'object' && o['state'] !== null;
}

// Trash-Icon (Heroicons-Outline-Style) — clean, accent-color aus tool-sens-danger.
const TRASH_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>`;

function buildAppTopbar(opts: {
  onDelete: () => void;
}): { host: HTMLElement; setTitle: (title: string) => void } {
  const titleEl = el('h1', { class: 'app-detail-title', text: '' });
  const back = el('a', { href: '#/apps', class: 'app-back-link', text: '← Apps' });

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'icon-btn app-delete-btn';
  deleteBtn.setAttribute('aria-label', 'App loeschen');
  deleteBtn.setAttribute('title', 'App loeschen');
  deleteBtn.innerHTML = TRASH_SVG;
  deleteBtn.addEventListener('click', opts.onDelete);

  const topRow = el('div', { class: 'app-detail-top-row' }, [back, deleteBtn]);

  const host = el('header', { class: 'topbar app-detail-topbar' }, [topRow, titleEl]);
  return {
    host,
    setTitle(t: string) {
      titleEl.textContent = t;
    },
  };
}

/**
 * Render compact refs section for the app-detail view (PLAN-doc-linking §10.5).
 * Identical chip-style + collapsible-details semantics as storage-detail,
 * but lives in the app's main-container above the block-layout.
 * Returns null when both directions empty.
 */
function renderAppRefs(refs: KnowledgeObjectRefs | undefined): HTMLElement | null {
  const outgoing = refs?.outgoing ?? [];
  const incoming = refs?.incoming ?? [];
  if (outgoing.length === 0 && incoming.length === 0) return null;
  const details = document.createElement('details');
  details.className = 'storage-refs card';
  details.open = false;
  const sum = document.createElement('summary');
  sum.className = 'storage-refs-summary-row';
  sum.textContent = `🔗 Verknüpfungen (${outgoing.length + incoming.length})`;
  details.appendChild(sum);
  const body = document.createElement('div');
  body.className = 'storage-refs-body';
  for (const dir of ['outgoing', 'incoming'] as const) {
    const refsForDir = refs?.[dir] ?? [];
    if (refsForDir.length === 0) continue;
    const row = document.createElement('div');
    row.className = 'storage-refs-chip-row';
    for (const r of refsForDir) {
      row.appendChild(buildChip(r, dir));
    }
    body.appendChild(row);
  }
  details.appendChild(body);
  return details;
}

function buildChip(ref: RefView, dir: 'outgoing' | 'incoming'): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'storage-refs-chip';
  a.href = `#/storage/${ref.id}`;
  const iconMap: Record<string, [string, string]> = {
    resource: ['📎', '↩ Teil von'],
    references: ['↗', '↩ ref von'],
    depends_on: ['⚙', '↩ benutzt von'],
  };
  const labels = iconMap[ref.role] ?? ['·', '↩'];
  const prefix = dir === 'outgoing' ? labels[0] : labels[1];
  a.textContent = `${prefix} ${ref.title ?? ref.id}`;
  if (ref.summary) a.title = ref.summary;
  return a;
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
  storage: ApiStorageClient,
  appId: string,
): Promise<void> {
  const main = el('main', { class: 'app-detail' });

  async function handleDelete(): Promise<void> {
    const title = ctx.app?.title || appId;
    if (!window.confirm(`App "${title}" wirklich loeschen?\n\nDas kann nicht rueckgaengig gemacht werden.`)) {
      return;
    }
    try {
      await api.deleteApp(appId);
    } catch (err) {
      const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
      alert('Loeschen fehlgeschlagen: ' + msg);
      return;
    }
    window.location.hash = '#/apps';
  }

  const { host: topbarHost, setTitle } = buildAppTopbar({ onDelete: () => void handleDelete() });
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

    // PLAN-doc-linking §10.5 D1: Apps haben auch Refs (sind subtype=app:*).
    // Storage-API liefert die mit. Best-effort — wenn fail, App-Render
    // läuft trotzdem durch.
    storage
      .getObject(appId)
      .then((obj) => {
        const refsEl = renderAppRefs(obj.refs);
        if (refsEl) main.insertBefore(refsEl, main.firstChild);
      })
      .catch(() => {
        // silent — Refs sind optional
      });

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
