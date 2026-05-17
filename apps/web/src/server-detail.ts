/**
 * Server-Detail-Page — Full-Width One-Stop-Shop fuer einen Sub-MCP-Server.
 *
 * Plan-Ref: docs/plans/active/PLAN-tools-tab-ux-refactor.md (Phase B/C/D).
 *
 * Routes:
 *   #/tools/servers/<name>              → tab=overview (default)
 *   #/tools/servers/<name>/auth         → tab=auth (Phase C)
 *   #/tools/servers/<name>/defaults     → tab=defaults (Phase D)
 *   #/tools/servers/<name>/diagnostics  → tab=diagnostics
 *
 * BC-Alias:
 *   #/tools/servers/<name>/config       → redirect zu #/tools/servers/<name>/auth
 *   #/tools/servers/<name>/oauth/callback?state=...&code=...  (Phase 3 OAuth)
 *
 * Tabs:
 *   - Übersicht: name, baseUrl, displayName, Subscribe-Toggle, Tool-Count,
 *                last-refresh, Re-Discover-Knopf.
 *   - Auth: 3 Modi (service_bearer / oauth / api_token). Phase C befuellt.
 *   - Tool-Defaults: pro Tool dieses Servers Defaults. Phase D befuellt.
 *   - Diagnostik: last-refresh-ts, last-error, raw tool-cache.
 */
import type {
  ApiClient,
  InventoryGateway,
  InventoryResponse,
  Session,
} from './api.js';
import { ApiError } from './api.js';
import { logout, renderSessionExpired } from './auth.js';
import { renderHeader } from './components/header.js';
import { showToast } from './components/toast.js';

type DetailTab = 'overview' | 'auth' | 'defaults' | 'diagnostics';

const TAB_DEFS: ReadonlyArray<{ readonly id: DetailTab; readonly label: string }> = [
  { id: 'overview', label: 'Übersicht' },
  { id: 'auth', label: 'Auth' },
  { id: 'defaults', label: 'Tool-Defaults' },
  { id: 'diagnostics', label: 'Diagnostik' },
];

export function parseServerDetailTab(): DetailTab {
  const hash = window.location.hash;
  // #/tools/servers/<name>/<tab>
  const m = hash.match(/^#\/tools\/servers\/[^/?]+\/([^/?]+)/);
  if (!m || !m[1]) return 'overview';
  const sub = m[1];
  if (sub === 'auth' || sub === 'defaults' || sub === 'diagnostics' || sub === 'overview') {
    return sub;
  }
  if (sub === 'config') return 'auth'; // BC-Alias
  return 'overview';
}

function fmtCachedAt(ms: number | null): string {
  if (!ms) return 'noch nie';
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `vor ${h}h`;
  const d = Math.floor(h / 24);
  return `vor ${d}d`;
}

function renderTabNav(active: DetailTab, serverName: string): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'settings-subnav server-detail-tabs';
  nav.setAttribute('aria-label', 'Server-Detail Sub-Sektionen');
  for (const t of TAB_DEFS) {
    const a = document.createElement('a');
    a.href =
      t.id === 'overview'
        ? `#/tools/servers/${encodeURIComponent(serverName)}`
        : `#/tools/servers/${encodeURIComponent(serverName)}/${t.id}`;
    a.textContent = t.label;
    a.className = 'settings-subnav-item';
    if (t.id === active) a.setAttribute('aria-current', 'page');
    nav.appendChild(a);
  }
  return nav;
}

function renderTopHeader(serverName: string, gw: InventoryGateway | null): HTMLElement {
  const head = document.createElement('header');
  head.className = 'server-detail-head';

  const back = document.createElement('a');
  back.href = '#/tools/servers';
  back.className = 'btn btn-secondary btn-small';
  back.textContent = '← Zurück';
  head.appendChild(back);

  const h1 = document.createElement('h1');
  h1.className = 'server-detail-title';
  h1.textContent = gw?.displayName ?? serverName;
  head.appendChild(h1);

  // Status-Pill
  const status = document.createElement('span');
  status.className = 'pill';
  if (!gw) {
    status.textContent = 'nicht abonniert';
    status.classList.add('pill-muted');
  } else if (!gw.enabled) {
    status.textContent = 'aus';
    status.classList.add('pill-muted');
  } else if ((gw.tools?.length ?? 0) === 0) {
    status.textContent = 'keine Tools';
    status.classList.add('pill-warn');
  } else {
    status.textContent = `${gw.tools.length} tools`;
    status.classList.add('pill-ok');
  }
  head.appendChild(status);

  return head;
}

// ─────────────────────────────────────────────────────────────────────────
// Tabs
// ─────────────────────────────────────────────────────────────────────────

async function renderOverviewTab(
  body: HTMLElement,
  api: ApiClient,
  serverName: string,
  gw: InventoryGateway | null,
  onChanged: () => void,
): Promise<void> {
  const card = document.createElement('section');
  card.className = 'card server-detail-section';

  const kv = (key: string, value: string): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'server-detail-kv';
    const k = document.createElement('span');
    k.className = 'server-detail-kv-key muted';
    k.textContent = key;
    const v = document.createElement('span');
    v.className = 'server-detail-kv-val';
    v.textContent = value;
    row.appendChild(k);
    row.appendChild(v);
    return row;
  };

  card.appendChild(kv('Name', serverName));
  card.appendChild(kv('Anzeigename', gw?.displayName ?? '—'));
  card.appendChild(kv(
    'Subscription',
    gw ? (gw.enabled ? 'aktiv' : 'aus') : 'nicht abonniert',
  ));
  card.appendChild(kv('Tools im Cache', String(gw?.tools?.length ?? 0)));
  card.appendChild(kv('Letzter Refresh', fmtCachedAt(gw?.toolsCachedAt ?? null)));
  if (gw?.isUserOwned) {
    card.appendChild(kv('Quelle', 'eigener Server (vom User angelegt)'));
  } else {
    card.appendChild(kv('Quelle', 'Catalog-Default (operator-managed)'));
  }

  body.appendChild(card);

  // Action-Row: Subscribe-Toggle + Refresh-Knopf
  const actions = document.createElement('div');
  actions.className = 'server-detail-actions';

  // Subscription-Toggle (nur fuer Sub-MCP-Gateways, nicht knowledge2/native)
  if (serverName !== 'knowledge2' && serverName !== 'native') {
    const toggleWrap = document.createElement('label');
    toggleWrap.className = `toggle-switch ${gw?.enabled ? 'is-on' : 'is-off'}`;
    const toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.className = 'toggle-switch-input';
    toggleInput.checked = gw?.enabled === true;
    const toggleSlider = document.createElement('span');
    toggleSlider.className = 'toggle-switch-slider';
    toggleWrap.appendChild(toggleInput);
    toggleWrap.appendChild(toggleSlider);

    const toggleLbl = document.createElement('span');
    toggleLbl.textContent = gw?.enabled ? 'Aktiv — Tools im MCP-Client sichtbar' : 'Deaktiviert';
    toggleLbl.className = 'muted small';

    const toggleRow = document.createElement('div');
    toggleRow.className = 'server-detail-action-row';
    toggleRow.appendChild(toggleWrap);
    toggleRow.appendChild(toggleLbl);
    actions.appendChild(toggleRow);

    toggleInput.addEventListener('change', async () => {
      try {
        await api.setServerSubscription(serverName, toggleInput.checked);
        showToast(toggleInput.checked ? `${serverName} aktiviert.` : `${serverName} deaktiviert.`, 'success');
        onChanged();
      } catch (err) {
        toggleInput.checked = !toggleInput.checked;
        showToast(`Fehler: ${(err as Error).message}`, 'error');
      }
    });
  }

  // Refresh-Knopf
  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'btn btn-secondary btn-small';
  refreshBtn.textContent = '↻ Tools neu entdecken';
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Lade…';
    try {
      const result = await api.rediscoverGateways(serverName);
      const r = result.results.find((x) => x.subMcpName === serverName);
      if (r?.error) {
        showToast(`Refresh-Fehler: ${r.error}`, 'error');
      } else {
        showToast(`Refresh OK — ${r?.count ?? 0} Tools entdeckt.`, 'success');
      }
      onChanged();
    } catch (err) {
      showToast(`Refresh fehlgeschlagen: ${(err as Error).message}`, 'error');
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = '↻ Tools neu entdecken';
    }
  });
  actions.appendChild(refreshBtn);

  body.appendChild(actions);
}

function renderAuthTabPlaceholder(body: HTMLElement, serverName: string): void {
  const card = document.createElement('section');
  card.className = 'card server-detail-section';
  const h = document.createElement('h2');
  h.textContent = 'Auth-Setup';
  card.appendChild(h);
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent =
    'Hier kannst du Tokens (Bearer, OAuth-Client-ID/Secret, API-Token) für diesen Server hinterlegen. ' +
    'Phase C des UX-Refactors befüllt diesen Tab.';
  card.appendChild(p);
  const link = document.createElement('a');
  link.href = `#/tools/servers/${encodeURIComponent(serverName)}/config`;
  link.className = 'btn btn-secondary btn-small';
  link.textContent = 'Bisherige Config-Drawer (Legacy) öffnen';
  card.appendChild(link);
  body.appendChild(card);
}

function renderDefaultsTabPlaceholder(body: HTMLElement, gw: InventoryGateway | null): void {
  const card = document.createElement('section');
  card.className = 'card server-detail-section';
  const h = document.createElement('h2');
  h.textContent = 'Tool-Defaults';
  card.appendChild(h);
  if (!gw || (gw.tools?.length ?? 0) === 0) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent =
      'Keine Tools im Cache. Aktiviere den Server + entdecke Tools neu, um Defaults zu setzen.';
    card.appendChild(p);
  } else {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = `${gw.tools.length} Tools verfügbar. Phase D befüllt diesen Tab mit per-Tool-Default-Forms.`;
    card.appendChild(p);
    const ul = document.createElement('ul');
    ul.className = 'tool-list';
    for (const t of gw.tools) {
      const li = document.createElement('li');
      li.className = 'tool-row';
      const name = document.createElement('span');
      name.className = 'tool-name';
      name.textContent = t.name;
      li.appendChild(name);
      card.appendChild(li);
      ul.appendChild(li);
    }
    card.appendChild(ul);
  }
  body.appendChild(card);
}

function renderDiagnosticsTab(body: HTMLElement, gw: InventoryGateway | null, serverName: string): void {
  const card = document.createElement('section');
  card.className = 'card server-detail-section';
  const h = document.createElement('h2');
  h.textContent = 'Diagnostik';
  card.appendChild(h);

  if (!gw) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent =
      `Server "${serverName}" ist nicht im Inventar — entweder nicht abonniert oder existiert nicht.`;
    card.appendChild(p);
    body.appendChild(card);
    return;
  }

  const dl = document.createElement('dl');
  dl.className = 'server-detail-dl';
  const append = (term: string, def: string): void => {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = def;
    dl.appendChild(dt);
    dl.appendChild(dd);
  };
  append('Letzter Refresh-Zeitpunkt', fmtCachedAt(gw.toolsCachedAt));
  append('Anzahl Tools im Cache', String(gw.tools?.length ?? 0));
  append('Sub-MCP enabled (server-side)', gw.enabled ? 'ja' : 'nein');
  append('isUserOwned', gw.isUserOwned ? 'ja' : 'nein');
  append('Required-Credentials', gw.requiredCredentials?.length
    ? gw.requiredCredentials.map((c) => `${c.provider} (${c.kind ?? 'any'})`).join(', ')
    : 'keine deklariert');
  card.appendChild(dl);

  if (gw.configSchema) {
    const detailsBox = document.createElement('details');
    detailsBox.className = 'card-section';
    const summary = document.createElement('summary');
    summary.textContent = 'Raw config_schema (vom Worker via tools/list._meta)';
    detailsBox.appendChild(summary);
    const pre = document.createElement('pre');
    pre.className = 'small';
    pre.style.overflowX = 'auto';
    pre.textContent = JSON.stringify(gw.configSchema, null, 2);
    detailsBox.appendChild(pre);
    card.appendChild(detailsBox);
  }

  body.appendChild(card);
}

// ─────────────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────────────

export async function renderServerDetail(
  root: HTMLElement,
  api: ApiClient,
  session: Session,
  serverName: string,
): Promise<void> {
  root.replaceChildren();
  renderHeader(root, session, () => void logout(api));

  const main = document.createElement('main');
  main.className = 'server-detail';

  // Inventory laden — gibt uns auch die Tool-Liste + last-refresh
  let inv: InventoryResponse;
  try {
    inv = await api.listInventory();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      renderSessionExpired(root);
      return;
    }
    const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
    const p = document.createElement('p');
    p.className = 'error';
    p.textContent = `Inventar laden fehlgeschlagen: ${msg}`;
    main.appendChild(p);
    root.appendChild(main);
    return;
  }

  // gw kann null sein wenn der Server nicht abonniert ist — wir zeigen
  // trotzdem den Detail-View damit der User aktivieren kann.
  const gw = inv.gateways.find((g) => g.name === serverName) ?? null;
  const available = inv.available?.find((g) => g.name === serverName);

  main.appendChild(renderTopHeader(serverName, gw));
  const activeTab = parseServerDetailTab();
  main.appendChild(renderTabNav(activeTab, serverName));

  // Wenn nur in available (nicht abonniert): Hint + Aktivieren-Knopf oben
  if (!gw && available) {
    const banner = document.createElement('div');
    banner.className = 'banner banner-info';
    banner.textContent =
      `Dieser Server ist nicht aktiviert. Aktiviere ihn um die ${available.toolsCount} Tools zu nutzen.`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary btn-small';
    btn.textContent = 'Aktivieren';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api.setServerSubscription(serverName, true);
        showToast(`${serverName} aktiviert.`, 'success');
        await renderServerDetail(root, api, session, serverName);
      } catch (err) {
        btn.disabled = false;
        showToast(`Fehler: ${(err as Error).message}`, 'error');
      }
    });
    banner.appendChild(btn);
    main.appendChild(banner);
  }

  const body = document.createElement('div');
  body.className = 'server-detail-body';

  const onChanged = async (): Promise<void> => {
    // Re-render full page (einfacher als state-diff)
    await renderServerDetail(root, api, session, serverName);
  };

  switch (activeTab) {
    case 'overview':
      await renderOverviewTab(body, api, serverName, gw, () => void onChanged());
      break;
    case 'auth':
      renderAuthTabPlaceholder(body, serverName);
      break;
    case 'defaults':
      renderDefaultsTabPlaceholder(body, gw);
      break;
    case 'diagnostics':
      renderDiagnosticsTab(body, gw, serverName);
      break;
  }

  main.appendChild(body);
  root.appendChild(main);
}
