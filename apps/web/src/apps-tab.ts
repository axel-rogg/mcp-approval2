/**
 * Apps-Tab — list + minimal create form.
 *
 * Routes:
 *   #/apps        → list with "+ New" form
 *   #/apps/:id    → detail (rendered via apps-detail.ts)
 *
 * Multi-User-Hinweis: ApiAppsClient ist same-origin und bringt das Session-
 * Cookie mit (`credentials: 'include'`). Server-side filtert mcp-knowledge2
 * per `sub=userId` aus dem JWT.
 */
import { ApiError } from './api.js';
import type { ApiClient, Session } from './api.js';
import type { ApiAppsClient, AppInstance } from './api-apps.js';
import { el } from './blocks/types.js';
import { renderHeader } from './components/header.js';
import { logout } from './auth.js';

function fmtAge(now: number, ms: number | null | undefined): string {
  if (!ms) return '';
  const diff = now - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function appCard(app: AppInstance, now: number): HTMLElement {
  const link = el('a', {
    class: 'app-card-link',
    href: `#/apps/${encodeURIComponent(app.id)}`,
  }, [
    el('h3', { class: 'app-card-title', text: app.title || app.id }),
    el('div', { class: 'app-card-meta muted small' }, [
      el('span', { class: 'pill', text: app.type }),
      el('span', { text: `v${app.state_version}` }),
      app.last_used_at ? el('span', { text: fmtAge(now, app.last_used_at) }) : null,
      app.archived ? el('span', { class: 'pill', text: 'archived' }) : null,
      app.pinned ? el('span', { class: 'pill pill-ok', text: 'pinned' }) : null,
    ]),
  ]);

  return el('li', { class: 'card app-card', 'data-id': app.id }, [link]);
}

function emptyState(): HTMLElement {
  return el('div', { class: 'card empty-state' }, [
    el('h2', { text: 'No apps yet' }),
    el('p', {
      class: 'muted',
      text: 'Apps are usually created via Claude/MCP ("build me a meditation tracker"). You can also create one manually below.',
    }),
  ]);
}

function createForm(api: ApiAppsClient, reload: () => Promise<void>): HTMLElement {
  const typeInput = el('input', {
    type: 'text',
    placeholder: 'Block type (e.g. counter, list, timer)',
    required: true,
    maxlength: 64,
  }) as HTMLInputElement;
  const titleInput = el('input', {
    type: 'text',
    placeholder: 'Title (optional)',
    maxlength: 200,
  }) as HTMLInputElement;
  const statusEl = el('span', { class: 'form-status muted small' });
  const submitBtn = el('button', { type: 'submit', class: 'btn', text: 'Create' });

  const form = el('form', { class: 'form card', id: 'create-app-form' }, [
    el('h3', { text: 'Create a new app' }),
    el('div', { class: 'field' }, [el('label', { text: 'Block type' }), typeInput]),
    el('div', { class: 'field' }, [el('label', { text: 'Title' }), titleInput]),
    el('div', { class: 'form-actions row' }, [submitBtn, statusEl]),
  ]) as HTMLFormElement;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const appType = typeInput.value.trim();
    if (!appType) return;
    submitBtn.disabled = true;
    statusEl.textContent = 'Creating…';
    statusEl.className = 'form-status muted small';
    try {
      const args: { appType: string; title?: string } = { appType };
      const title = titleInput.value.trim();
      if (title) args.title = title;
      await api.createApp(args);
      typeInput.value = '';
      titleInput.value = '';
      statusEl.textContent = 'OK';
      statusEl.className = 'form-status ok small';
      await reload();
    } catch (err) {
      const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
      statusEl.textContent = msg;
      statusEl.className = 'form-status err small';
    } finally {
      submitBtn.disabled = false;
    }
  });

  return form;
}

export async function renderAppsTab(
  root: HTMLElement,
  api: ApiAppsClient,
  authApi: ApiClient,
  session: Session,
): Promise<void> {
  root.replaceChildren();
  renderHeader(root, session, () => void logout(authApi));

  const main = el('main', { class: 'apps-tab' });
  const listHost = el('ul', { class: 'apps-list' });
  const formHost = el('div');

  async function reload(): Promise<void> {
    listHost.replaceChildren(el('p', { class: 'muted', text: 'Loading…' }));
    let apps: AppInstance[];
    try {
      apps = await api.listApps();
    } catch (err) {
      const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
      listHost.replaceChildren(el('p', { class: 'err', text: 'Failed to load apps: ' + msg }));
      return;
    }
    if (apps.length === 0) {
      listHost.replaceChildren(emptyState());
      return;
    }
    const now = Date.now();
    listHost.replaceChildren();
    for (const a of apps) listHost.appendChild(appCard(a, now));
  }

  formHost.appendChild(createForm(api, reload));

  main.appendChild(el('header', { class: 'apps-tab-header' }, [el('h1', { text: 'Apps' })]));
  main.appendChild(listHost);
  main.appendChild(formHost);

  root.appendChild(main);
  await reload();
}
