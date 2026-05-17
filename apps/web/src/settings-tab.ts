/**
 * Settings-Tab mit Sub-Tabs — Container fuer selten-genutzte Konfigurationen.
 *
 * Sub-Routes:
 *   #/settings                  → Default (Authenticators)
 *   #/settings/authenticators   → WebAuthn Passkey-Mgmt (Stub — TODO)
 *   #/settings/app              → App-Info + Sign-out
 *
 * Hinweis (2026-05-17): "MCP-Credentials" wurden aus Settings entfernt und
 * leben jetzt unter `#/tools/credentials` (semantisch gehoeren sie zur
 * MCP-Server-Anbindung, nicht zu App-Settings). Legacy-URL
 * `#/settings/credentials` redirected in main.ts auf den neuen Pfad.
 */
import type { ApiClient, Session } from './api.js';
import { logout, renderSessionExpired, enrollPasskey } from './auth.js';
import { authedFetch } from './auth-token.js';
import { renderHeader } from './components/header.js';
import { showToast } from './components/toast.js';

type SettingsSubTab = 'authenticators' | 'app';

interface SubTabSpec {
  readonly id: SettingsSubTab;
  readonly href: string;
  readonly label: string;
}

const SUB_TABS: ReadonlyArray<SubTabSpec> = [
  { id: 'authenticators', href: '#/settings/authenticators', label: 'Passkeys' },
  { id: 'app', href: '#/settings/app', label: 'App' },
];

function parseSettingsSubTab(): SettingsSubTab {
  const hash = window.location.hash;
  const m = hash.match(/^#\/settings\/([^?]+)/);
  if (!m || !m[1]) return 'authenticators';
  const sub = m[1];
  if (sub === 'app' || sub === 'authenticators') return sub;
  return 'authenticators';
}

function renderSubNav(active: SettingsSubTab): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'settings-subnav';
  nav.setAttribute('aria-label', 'Settings sections');
  for (const tab of SUB_TABS) {
    const a = document.createElement('a');
    a.href = tab.href;
    a.textContent = tab.label;
    a.className = 'settings-subnav-item';
    if (tab.id === active) a.setAttribute('aria-current', 'page');
    nav.appendChild(a);
  }
  return nav;
}

interface PasskeyRow {
  readonly credentialIdB64: string;
  readonly friendlyName: string | null;
  readonly prfSupported: boolean;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly invalidatedAt: number | null;
}

async function fetchPasskeys(): Promise<PasskeyRow[]> {
  const base = window.location.origin;
  const res = await authedFetch(
    new URL('/v1/passkeys', base).toString(),
    { method: 'GET', headers: { accept: 'application/json' } },
    base,
  );
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { passkeys: PasskeyRow[] };
  return body.passkeys ?? [];
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString('de-DE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function passkeyShort(idB64: string): string {
  return idB64.length <= 10 ? idB64 : idB64.slice(0, 8) + '…';
}

async function renderAuthenticators(container: HTMLElement): Promise<void> {
  const h1 = document.createElement('h1');
  h1.textContent = 'Passkeys';
  container.appendChild(h1);

  const card = document.createElement('section');
  card.className = 'card';
  card.style.display = 'flex';
  card.style.flexDirection = 'column';
  card.style.gap = '0.75rem';

  const explain = document.createElement('p');
  explain.className = 'muted';
  explain.textContent =
    'Passkeys werden fuer Approval-Sign-Off und Write-Mode-Aktivierung verwendet. ' +
    'Jedes Geraet braucht einen eigenen Passkey (z.B. iCloud-/Google-Password-Manager ' +
    'syncen automatisch zwischen Geraeten desselben Accounts).';
  card.appendChild(explain);

  const list = document.createElement('ul');
  list.className = 'list';
  list.style.padding = '0';
  list.style.listStyle = 'none';
  const loading = document.createElement('li');
  loading.className = 'muted';
  loading.textContent = 'Lade …';
  list.appendChild(loading);
  card.appendChild(list);

  const status = document.createElement('p');
  status.className = 'muted';
  status.style.minHeight = '1.2em';
  card.appendChild(status);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn-primary';
  addBtn.textContent = '+ Passkey hinzufuegen';
  card.appendChild(addBtn);

  container.appendChild(card);

  async function refresh(): Promise<void> {
    list.replaceChildren();
    try {
      const passkeys = await fetchPasskeys();
      if (passkeys.length === 0) {
        const li = document.createElement('li');
        li.className = 'muted';
        li.textContent = 'Noch keine Passkeys — klicke unten "Hinzufuegen".';
        list.appendChild(li);
        return;
      }
      for (const p of passkeys) {
        const li = document.createElement('li');
        li.style.padding = '0.5rem 0';
        li.style.borderTop = '1px solid var(--border, #e0e0e0)';

        const title = document.createElement('div');
        title.style.fontWeight = '600';
        title.textContent = p.friendlyName ?? 'Authenticator';
        if (p.invalidatedAt !== null) {
          const badge = document.createElement('span');
          badge.textContent = ' (invalidiert)';
          badge.style.color = 'var(--text-muted, #888)';
          badge.style.fontWeight = '400';
          badge.style.fontSize = '0.85em';
          title.appendChild(badge);
        }
        if (p.prfSupported) {
          const badge = document.createElement('span');
          badge.textContent = ' · PRF';
          badge.style.color = 'var(--text-muted, #888)';
          badge.style.fontWeight = '400';
          badge.style.fontSize = '0.85em';
          title.appendChild(badge);
        }
        li.appendChild(title);

        const meta = document.createElement('div');
        meta.className = 'muted';
        meta.style.fontSize = '0.85em';
        meta.style.fontFamily = 'var(--font-mono, monospace)';
        const lastUsed = p.lastUsedAt !== null ? fmtDate(p.lastUsedAt) : 'nie';
        meta.textContent = `id: ${passkeyShort(p.credentialIdB64)} · seit ${fmtDate(p.createdAt)} · zuletzt ${lastUsed}`;
        li.appendChild(meta);

        list.appendChild(li);
      }
    } catch (err) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'Liste konnte nicht geladen werden: ' + (err as Error).message;
      list.appendChild(li);
    }
  }

  if (typeof navigator === 'undefined' || !('credentials' in navigator)) {
    addBtn.disabled = true;
    status.textContent = 'WebAuthn wird in diesem Browser nicht unterstuetzt.';
  } else {
    addBtn.addEventListener('click', async () => {
      addBtn.disabled = true;
      status.textContent = 'Bestaetige am Geraet …';
      try {
        const { prfSupported } = await enrollPasskey();
        showToast(
          prfSupported
            ? 'Passkey registriert (mit PRF-Unterstuetzung).'
            : 'Passkey registriert (ohne PRF — Credential-Encryption nicht moeglich).',
          'success',
        );
        await refresh();
        status.textContent = '';
      } catch (err) {
        const msg = (err as Error).message ?? 'unbekannt';
        if (msg.includes('NotAllowedError') || msg.includes('abgebrochen')) {
          status.textContent = 'Registrierung abgebrochen.';
        } else {
          status.textContent = 'Registrierung fehlgeschlagen: ' + msg;
        }
      } finally {
        addBtn.disabled = false;
      }
    });
  }

  await refresh();
}

function renderAppInfo(container: HTMLElement, api: ApiClient, session: Session): void {
  const h1 = document.createElement('h1');
  h1.textContent = 'App';
  container.appendChild(h1);

  const card = document.createElement('section');
  card.className = 'card';

  const dl = document.createElement('dl');
  dl.className = 'app-info-list';

  const rows: Array<[string, string]> = [
    ['Angemeldet als', session.email ?? '—'],
    ['Build', 'mcp-approval2'],
  ];

  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  card.appendChild(dl);

  const actions = document.createElement('div');
  actions.className = 'row';
  actions.style.marginTop = '0.75rem';

  const debugLink = document.createElement('a');
  debugLink.href = '#/debug';
  debugLink.className = 'btn btn-secondary btn-small';
  debugLink.textContent = 'Debug-Log';
  actions.appendChild(debugLink);

  const logoutBtn = document.createElement('button');
  logoutBtn.type = 'button';
  logoutBtn.className = 'btn btn-secondary btn-small btn-danger';
  logoutBtn.textContent = 'Abmelden';
  logoutBtn.addEventListener('click', () => void logout(api));
  actions.appendChild(logoutBtn);

  card.appendChild(actions);
  container.appendChild(card);
}

export async function renderSettings(
  root: HTMLElement,
  api: ApiClient,
  session: Session,
): Promise<void> {
  root.replaceChildren();
  renderHeader(root, session, () => void logout(api));

  const main = document.createElement('main');
  main.className = 'settings-tab';

  const active = parseSettingsSubTab();
  main.appendChild(renderSubNav(active));

  const body = document.createElement('div');
  body.className = 'settings-body';
  main.appendChild(body);

  root.appendChild(main);

  try {
    if (active === 'app') {
      renderAppInfo(body, api, session);
    } else {
      await renderAuthenticators(body);
    }
  } catch (err) {
    console.error('settings render failed', err);
    renderSessionExpired(root);
  }
}
