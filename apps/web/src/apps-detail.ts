/**
 * Apps-Detail-View — single app with block rendering.
 *
 * Reads `/v1/apps/:id` (returns { app, state }). The state is a LayoutDoc
 * with `components[]` (Block-Instances) and a global `state{}` (DataModel
 * keyed by block-id).
 *
 * Per Block:
 *   - Lookup renderer in registry by component.block
 *   - Pass block-state from layout.state[component.id]
 *   - onAction triggers POST /v1/apps/:id/invoke {block_id, action, payload}
 *   - After invoke, re-fetch + re-render (eventually-consistent UI)
 */
import { ApiError } from './api.js';
import type { ApiAppsClient, AppRead, LayoutDoc } from './api-apps.js';
import { getRenderer } from './blocks/registry.js';
import { el } from './blocks/types.js';

function isLayoutDoc(v: unknown): v is LayoutDoc {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o['components']) && typeof o['state'] === 'object' && o['state'] !== null;
}

// App-Detail hat einen eigenen Topbar: keine globalen Tabs/Brand, stattdessen
// "← Apps"-Back-Link + grosser App-Titel. Tech-Meta ('composable v1') wird
// bewusst NICHT angezeigt — der User braucht keine Schema-Internals.
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
      text: 'This app has no layout components yet. Layout is usually set up via Claude/MCP.',
    }),
  ]);
}

function renderBlock(
  api: ApiAppsClient,
  appId: string,
  blockId: string,
  blockType: string,
  blockState: unknown,
  config: Record<string, unknown>,
  reload: () => Promise<void>,
): HTMLElement | null {
  const renderer = getRenderer(blockType);
  if (!renderer) {
    // Silent skip — Block-Type ist noch nicht im PWA-Renderer-Registry
    // (z.B. neue Server-side Block-Defs die der Client noch nicht kennt).
    // Server-side Validation hat den Block akzeptiert, aber wir koennen
    // ihn lokal nicht zeichnen. Console-Hinweis fuer Devs.
    console.warn('apps-detail: renderer missing for block', { blockId, blockType });
    return null;
  }

  const onAction = async (
    action: string,
    payload?: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await api.invoke({
        id: appId,
        block_id: blockId,
        action,
        payload: payload ?? {},
      });
      await reload();
    } catch (err) {
      const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
      console.error('invoke failed', { blockId, action, err });
      // surface to the user; non-blocking
      alert('Action failed: ' + msg);
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
        text: `Renderer for "${blockType}" failed: ${e instanceof Error ? e.message : String(e)}`,
      }),
    );
  }
  return wrap;
}

export async function renderAppDetail(
  root: HTMLElement,
  api: ApiAppsClient,
  appId: string,
): Promise<void> {
  const main = el('main', { class: 'app-detail' });
  const { host: topbarHost, setTitle } = buildAppTopbar();
  root.replaceChildren(topbarHost, main);

  async function reload(): Promise<void> {
    main.replaceChildren(el('p', { class: 'muted', text: 'Lade App…' }));
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
    main.replaceChildren();

    if (!isLayoutDoc(read.state)) {
      main.appendChild(renderEmptyLayout());
      return;
    }
    const layout = read.state;
    if (layout.components.length === 0) {
      main.appendChild(renderEmptyLayout());
      return;
    }
    for (const comp of layout.components) {
      const blockState = (layout.state as Record<string, unknown>)[comp.id];
      const config = comp.config ?? {};
      const node = renderBlock(api, appId, comp.id, comp.block, blockState, config, reload);
      if (node) main.appendChild(node);
    }
  }

  await reload();
}
