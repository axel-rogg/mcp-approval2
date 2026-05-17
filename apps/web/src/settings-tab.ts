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
import { logout, renderSessionExpired } from './auth.js';
import { renderHeader } from './components/header.js';

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

function renderAuthenticatorsStub(container: HTMLElement): void {
  const h1 = document.createElement('h1');
  h1.textContent = 'Passkeys';
  container.appendChild(h1);

  const card = document.createElement('section');
  card.className = 'card';

  const p1 = document.createElement('p');
  p1.textContent =
    'Verwaltung der WebAuthn-Authenticator (Passkeys) fuer Approvals und ' +
    'Credential-Encryption.';
  card.appendChild(p1);

  const p2 = document.createElement('p');
  p2.className = 'muted';
  p2.textContent =
    'UI in Vorbereitung — derzeit erfolgt das Passkey-Enrollment automatisch ' +
    'beim ersten Google-Login (#/enroll-passkey).';
  card.appendChild(p2);

  container.appendChild(card);
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
      renderAuthenticatorsStub(body);
    }
  } catch (err) {
    console.error('settings render failed', err);
    renderSessionExpired(root);
  }
}
