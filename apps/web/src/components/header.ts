/**
 * Top-Nav-Header — 2-Reihen-Layout portiert aus v1 (mcp-approval).
 *
 * Row 1: Brand links + Icon-Actions rechts (Tools, Storage, Defaults, Settings, Logout).
 * Row 2: Primary-Tab-Nav (Approvals, Write-Mode, Apps).
 *
 * Hash-basierte Navigation — `main.ts` reagiert auf `hashchange`. Active-State
 * via `aria-current="page"` (gleichzeitig CSS-Hook + Screen-Reader-Hint).
 */
import type { Session } from '../api.js';

interface NavItem {
  readonly href: string;
  readonly label: string;
}

interface IconAction {
  readonly href: string;
  readonly label: string;
  readonly svg: string;
}

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { href: '#/approvals', label: 'Approvals' },
  { href: '#/writemode', label: 'Write-Mode' },
  { href: '#/apps', label: 'Apps' },
];

// SVGs portiert aus v1 — feather-style outline, 18×18, stroke=currentColor.
const ICON_ACTIONS: ReadonlyArray<IconAction> = [
  {
    href: '#/tools',
    label: 'Tools',
    // v1 'Tools'-Icon: Schraubenschluessel (wrench) — Server/Tool-Inventar
    svg: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`,
  },
  {
    href: '#/storage',
    label: 'Storage',
    svg: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v6c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6"/></svg>`,
  },
  {
    href: '#/defaults',
    label: 'Defaults',
    svg: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>`,
  },
  {
    href: '#/settings',
    label: 'Settings',
    svg: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  },
];

// Admin-only Icon — wird nur fuer session.role==='admin' im header geadded.
const ADMIN_ICON: IconAction = {
  href: '#/admin',
  label: 'Admin (Users / Invites / Outbox / Audit)',
  // Feather "shield" — symbolisiert Admin-Privilegien.
  svg: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
};

const LOGOUT_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`;

function currentRouteHash(): string {
  return window.location.hash || '#/approvals';
}

function isActive(itemHref: string, currentHash: string): boolean {
  // Match by prefix so '#/approvals/abc' highlights the 'Approvals' tab,
  // '#/settings/credentials' highlights the Settings icon, etc.
  // But guard against partial-word matches: '#/apps' must not match '#/approvals'.
  if (currentHash === itemHref) return true;
  return currentHash.startsWith(itemHref + '/') || currentHash.startsWith(itemHref + '?');
}

export function renderHeader(root: HTMLElement, session: Session, onLogout: () => void): void {
  const header = document.createElement('header');
  header.className = 'topbar';
  header.setAttribute('role', 'banner');

  const currentHash = currentRouteHash();

  // ── Row 1: Brand + Icon-Actions ────────────────────────────────────
  const row1 = document.createElement('div');
  row1.className = 'topbar-row';

  const brandLink = document.createElement('a');
  brandLink.href = '#/approvals';
  brandLink.className = 'brand';
  brandLink.textContent = 'MCP Approval';
  row1.appendChild(brandLink);

  const actions = document.createElement('div');
  actions.className = 'topbar-actions';

  // Admin-Icon nur fuer admins anzeigen. Wir spleißen es VOR dem
  // Settings-Icon, damit es ein "Owner-Tools"-Cluster gibt.
  const iconActions: IconAction[] = [...ICON_ACTIONS];
  if (session.role === 'admin') {
    iconActions.splice(iconActions.length - 1, 0, ADMIN_ICON);
  }

  for (const action of iconActions) {
    const a = document.createElement('a');
    a.href = action.href;
    a.className = 'nav-icon';
    a.setAttribute('aria-label', action.label);
    a.setAttribute('title', action.label);
    a.innerHTML = action.svg;
    if (isActive(action.href, currentHash)) {
      a.setAttribute('aria-current', 'page');
    }
    actions.appendChild(a);
  }

  const logoutBtn = document.createElement('button');
  logoutBtn.type = 'button';
  logoutBtn.className = 'icon-btn';
  logoutBtn.setAttribute('aria-label', 'Abmelden');
  logoutBtn.setAttribute('title', 'Abmelden');
  logoutBtn.innerHTML = LOGOUT_SVG;
  logoutBtn.addEventListener('click', onLogout);
  actions.appendChild(logoutBtn);

  row1.appendChild(actions);
  header.appendChild(row1);

  // ── Row 2: Primary-Tab-Nav ─────────────────────────────────────────
  const nav = document.createElement('nav');
  nav.className = 'nav';
  nav.setAttribute('aria-label', 'Primary');

  for (const item of NAV_ITEMS) {
    const a = document.createElement('a');
    a.href = item.href;
    a.textContent = item.label;
    if (isActive(item.href, currentHash)) {
      a.setAttribute('aria-current', 'page');
    }
    nav.appendChild(a);
  }
  header.appendChild(nav);

  // Email-Anzeige bewusst NICHT im Header (User-Wunsch 2026-05-17).
  // session-Param wird oben fuer admin-Icon-Visibility benutzt.

  root.appendChild(header);
}
