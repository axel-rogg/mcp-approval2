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
import type { ApiAppsClient, AppInstance, AppRead, LayoutDoc } from './api-apps.js';
import { getRenderer } from './blocks/registry.js';
import { el } from './blocks/types.js';

function topbar(): HTMLElement {
  return el('nav', { class: 'topbar' }, [
    el('div', { class: 'topbar-brand' }, [el('a', { href: '#/approvals', text: 'mcp-approval2' })]),
    el('div', { class: 'topbar-nav' }, [
      el('a', { href: '#/approvals', text: 'Approvals' }),
      el('a', { href: '#/apps', class: 'active', text: 'Apps' }),
      el('a', { href: '#/credentials', text: 'Credentials' }),
    ]),
  ]);
}

function isLayoutDoc(v: unknown): v is LayoutDoc {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o['components']) && typeof o['state'] === 'object' && o['state'] !== null;
}

function renderHeader(app: AppInstance): HTMLElement {
  return el('header', { class: 'app-detail-header' }, [
    el('div', { class: 'row' }, [
      el('a', { href: '#/apps', class: 'btn btn-secondary btn-small', text: '← Apps' }),
      el('h1', { text: app.title || app.id }),
    ]),
    el('div', { class: 'muted small' }, [
      el('span', { class: 'pill', text: app.type }),
      el('span', { text: ` v${app.state_version}` }),
    ]),
  ]);
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
): HTMLElement {
  const renderer = getRenderer(blockType);
  if (!renderer) {
    return el('div', { class: 'card block-unknown' }, [
      el('p', { class: 'err', text: `Unknown block type: ${blockType}` }),
      el('p', { class: 'muted small', text: `Block id: ${blockId}` }),
    ]);
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
  root.replaceChildren(topbar(), main);

  async function reload(): Promise<void> {
    main.replaceChildren(el('p', { class: 'muted', text: 'Loading app…' }));
    let read: AppRead;
    try {
      read = await api.getApp(appId);
    } catch (err) {
      const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
      main.replaceChildren(
        el('div', { class: 'card' }, [
          el('p', { class: 'err', text: 'Failed to load app: ' + msg }),
          el('a', { href: '#/apps', class: 'btn btn-secondary', text: '← Back to apps' }),
        ]),
      );
      return;
    }

    main.replaceChildren();
    main.appendChild(renderHeader(read.app));

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
      main.appendChild(
        renderBlock(api, appId, comp.id, comp.block, blockState, config, reload),
      );
    }
  }

  await reload();
}
