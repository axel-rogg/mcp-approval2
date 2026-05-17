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
import { authedFetch } from '../auth-token.js';

// Globaler Singleton-Tick fuer das Write-Mode-Countdown-Pill. Erste
// renderHeader()-Aufruf startet einen einzigen setInterval, alle weiteren
// Header-Renders pluggen sich in dasselbe Update-Loop ein. Verhindert dass
// nach jedem Route-Wechsel (renderHeader wird oft neu aufgerufen) mehrere
// Tick-Loops parallel laufen und CPU verbrennen.
let wmExpiresAt: number | null = null;
let wmTickHandle: number | null = null;
let wmLastFetch = 0;
const WM_FETCH_INTERVAL_MS = 30_000;
const wmListeners: Array<(remainingMs: number | null) => void> = [];

async function fetchWritemodeStatus(): Promise<number | null> {
  try {
    const base =
      typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8787';
    const res = await authedFetch(
      new URL('/v1/writemode/status', base).toString(),
      { method: 'GET', headers: { accept: 'application/json' } },
      base,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      active?: boolean;
      sessions?: Array<{ expires_at?: number }>;
    };
    if (!body.active || !body.sessions || body.sessions.length === 0) return null;
    const first = body.sessions[0]!;
    return typeof first.expires_at === 'number' ? first.expires_at : null;
  } catch {
    return null;
  }
}

function notifyWmListeners(): void {
  const remaining = wmExpiresAt === null ? null : wmExpiresAt - Date.now();
  for (const l of wmListeners) {
    try {
      l(remaining);
    } catch {
      /* listener errors are not fatal */
    }
  }
}

function ensureWmLoop(): void {
  if (wmTickHandle !== null) return;
  // Erste Fetch wenn noch nichts bekannt oder beim Start eines neuen Loops.
  if (Date.now() - wmLastFetch > WM_FETCH_INTERVAL_MS) {
    wmLastFetch = Date.now();
    void fetchWritemodeStatus().then((exp) => {
      wmExpiresAt = exp;
      notifyWmListeners();
    });
  }
  wmTickHandle = window.setInterval(() => {
    const now = Date.now();
    // Periodisch re-fetchen (Server-side Deaktivierung mitkriegen).
    if (now - wmLastFetch > WM_FETCH_INTERVAL_MS) {
      wmLastFetch = now;
      void fetchWritemodeStatus().then((exp) => {
        wmExpiresAt = exp;
        notifyWmListeners();
      });
    }
    // Wenn aktiv: Countdown jede Sekunde pingen. Wenn abgelaufen: ausblenden.
    if (wmExpiresAt !== null && wmExpiresAt <= now) {
      wmExpiresAt = null;
    }
    notifyWmListeners();
  }, 1000);
}

/**
 * Forciert ein sofortiges Refetch des Write-Mode-Status. Wird vom writemode-
 * tab nach activate/deactivate aufgerufen, damit das Header-Pill ohne
 * 30s-Latenz updated.
 */
export function refreshWritemodeIndicator(): void {
  wmLastFetch = 0; // forciert next-tick-fetch
  void fetchWritemodeStatus().then((exp) => {
    wmExpiresAt = exp;
    notifyWmListeners();
  });
}

function formatRemaining(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

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
  // 2026-05-17 UX-Refactor Phase E: Defaults-Top-Nav-Icon entfernt.
  // Tool-Defaults leben jetzt unter Tools → Server-Karte → Konfig → Tab
  // "Tool-Defaults". Die Legacy-Route #/defaults wird in main.ts auf
  // #/tools/servers/native/defaults umgeleitet — bestehende Bookmarks
  // funktionieren weiterhin, aber kein separates Top-Nav-Icon mehr.
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

  // ── Write-Mode-Countdown-Pill ──────────────────────────────────────
  // Zeigt verbleibende Auto-Approve-Zeit wenn Session aktiv. Klick fuehrt
  // direkt in den Write-Mode-Tab (Deaktivieren / Verlaengern).
  const wmPill = document.createElement('a');
  wmPill.href = '#/writemode';
  wmPill.className = 'wm-pill';
  wmPill.setAttribute('aria-label', 'Write-Mode aktiv — Klick fuer Details');
  wmPill.style.display = 'none';
  wmPill.style.padding = '2px 8px';
  wmPill.style.marginRight = '0.5rem';
  wmPill.style.borderRadius = '12px';
  wmPill.style.background = '#facc15'; // gelb-warning
  wmPill.style.color = '#000';
  wmPill.style.fontSize = '0.75rem';
  wmPill.style.fontWeight = '600';
  wmPill.style.fontVariantNumeric = 'tabular-nums';
  wmPill.style.textDecoration = 'none';
  wmPill.style.alignSelf = 'center';
  actions.appendChild(wmPill);

  // Listener registrieren + globalen Loop starten (idempotent).
  const wmListener = (remainingMs: number | null): void => {
    if (remainingMs === null || remainingMs <= 0) {
      wmPill.style.display = 'none';
      return;
    }
    wmPill.style.display = 'inline-flex';
    wmPill.textContent = `⚡ ${formatRemaining(remainingMs)}`;
  };
  wmListeners.push(wmListener);
  // Wenn header re-rendered wird (Route-Wechsel), den alten Listener
  // entfernen sobald das Element aus dem DOM verschwunden ist.
  const cleanup = (): void => {
    if (!document.body.contains(wmPill)) {
      const idx = wmListeners.indexOf(wmListener);
      if (idx >= 0) wmListeners.splice(idx, 1);
      window.removeEventListener('hashchange', cleanup);
    }
  };
  window.addEventListener('hashchange', cleanup);
  ensureWmLoop();
  // Sofort initial einmal triggern damit der Pill nicht erst nach 1s erscheint.
  if (wmExpiresAt !== null) {
    wmListener(wmExpiresAt - Date.now());
  }

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
