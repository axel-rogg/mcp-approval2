/**
 * Apps-Tab — read-only Liste der vom Agent erzeugten Apps.
 *
 * Routes:
 *   #/apps        → list (click → detail)
 *   #/apps/:id    → detail (rendered via apps-detail.ts)
 *
 * Apps werden NUR vom AI-Agent erstellt (via MCP `apps.create`-Tool) — die
 * PWA bietet kein Create-Form. UX-Entscheidung 2026-05-17: User triggert
 * App-Generierung per Conversation ("build me a meditation tracker"),
 * nicht per UI-Form.
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

// Trash-Icon inline-SVG (Heroicons-Outline-Style).
const TRASH_SVG_MARKUP = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>`;

function appCard(
  app: AppInstance,
  now: number,
  onDelete: (app: AppInstance) => void,
): HTMLElement {
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

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'icon-btn app-card-delete';
  deleteBtn.setAttribute('aria-label', `App "${app.title || app.id}" loeschen`);
  deleteBtn.setAttribute('title', 'App loeschen');
  deleteBtn.innerHTML = TRASH_SVG_MARKUP;
  deleteBtn.addEventListener('click', (e) => {
    // Verhindert dass der Card-Link triggert.
    e.preventDefault();
    e.stopPropagation();
    onDelete(app);
  });

  return el('li', { class: 'card app-card', 'data-id': app.id }, [link, deleteBtn]);
}

function emptyState(): HTMLElement {
  return el('div', { class: 'card empty-state' }, [
    el('h2', { text: 'Noch keine Apps' }),
    el('p', {
      class: 'muted',
      text:
        'Apps werden vom AI-Agent erzeugt (z.B. via Claude/MCP: "bau mir einen Meditations-Tracker"). ' +
        'Sobald welche existieren, erscheinen sie hier.',
    }),
  ]);
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

  async function handleDelete(appInst: AppInstance): Promise<void> {
    const title = appInst.title || appInst.id;
    if (!window.confirm(`App "${title}" wirklich loeschen?\n\nDas kann nicht rueckgaengig gemacht werden.`)) {
      return;
    }
    try {
      await api.deleteApp(appInst.id);
    } catch (err) {
      const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
      alert('Loeschen fehlgeschlagen: ' + msg);
      return;
    }
    await reload();
  }

  async function reload(): Promise<void> {
    listHost.replaceChildren(el('p', { class: 'muted', text: 'Lade…' }));
    let apps: AppInstance[];
    try {
      apps = await api.listApps();
    } catch (err) {
      const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
      listHost.replaceChildren(el('p', { class: 'err', text: 'Apps konnten nicht geladen werden: ' + msg }));
      return;
    }
    if (apps.length === 0) {
      listHost.replaceChildren(emptyState());
      return;
    }
    const now = Date.now();
    listHost.replaceChildren();
    for (const a of apps) {
      listHost.appendChild(appCard(a, now, (app) => void handleDelete(app)));
    }
  }

  main.appendChild(el('header', { class: 'apps-tab-header' }, [el('h1', { text: 'Apps' })]));
  main.appendChild(listHost);

  root.appendChild(main);
  await reload();
}
