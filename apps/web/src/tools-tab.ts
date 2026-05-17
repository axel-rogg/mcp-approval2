/**
 * Tools-Tab — Inventur aller registrierten Tools + Sub-MCP-Gateways +
 * Credentials-Mgmt.
 *
 * Sub-Routes:
 *   #/tools                  → default = #/tools/servers
 *   #/tools/servers          → Server-Liste mit Tool-Cards + Credential-Status
 *   #/tools/credentials      → MCP-Credentials (User-OAuth/PAT-Tokens)
 *
 * Architektur-Wahrheit: Credentials gehoeren zum MCP-Server-Anbindungs-
 * Kontext, nicht zu App-Settings. Daher hier als Sub-Tab. Settings haelt
 * nur noch Passkeys + App-Info.
 *
 * Per-Gateway Credential-Status: jeder Sub-MCP-Worker deklariert in seinen
 * Tool-Annotations `requires_credential: { provider, kind }`. Inventory
 * aggregiert das pro-Gateway. Tools-Tab zeigt pro Server-Card "Konfiguriert"
 * oder "Nicht konfiguriert" mit Quick-Link zum Credentials-Sub-Tab.
 */
import type {
  ApiClient,
  CredentialMeta,
  InventoryGatewayTool,
  InventoryNativeTool,
  InventoryRequiredCredential,
  InventoryResponse,
  RediscoverGatewaysResponse,
  Session,
} from './api.js';
import { ApiError } from './api.js';
import { logout, renderSessionExpired } from './auth.js';
import { renderHeader } from './components/header.js';
import { renderCredentialsDeclaredView, type CredentialSlot } from './credentials.js';

// ─────────────────────────────────────────────────────────────────────────
// Sub-Routes
// ─────────────────────────────────────────────────────────────────────────

type ToolsSubTab = 'servers' | 'credentials';

interface SubTabSpec {
  readonly id: ToolsSubTab;
  readonly href: string;
  readonly label: string;
}

const SUB_TABS: ReadonlyArray<SubTabSpec> = [
  { id: 'servers', href: '#/tools/servers', label: 'Servers' },
  { id: 'credentials', href: '#/tools/credentials', label: 'Credentials' },
];

function parseToolsSubTab(): ToolsSubTab {
  const hash = window.location.hash;
  const m = hash.match(/^#\/tools\/([^?]+)/);
  if (!m || !m[1]) return 'servers';
  const sub = m[1];
  if (sub === 'servers' || sub === 'credentials') return sub;
  return 'servers';
}

function renderSubNav(active: ToolsSubTab): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'settings-subnav tools-subnav';
  nav.setAttribute('aria-label', 'Tools sections');
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

// ─────────────────────────────────────────────────────────────────────────
// SVG-Icons (orange-rost via .btn-refresh)
// ─────────────────────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

function makeSvgIcon(pathData: string): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', pathData);
  svg.appendChild(p);
  return svg;
}

function makeRefreshIcon(): SVGElement {
  return makeSvgIcon('M21 12a9 9 0 0 1-15.5 6.4M3 12a9 9 0 0 1 15.5-6.4M21 4v5h-5M3 20v-5h5');
}

/**
 * Konfigurieren-Icon: Lucide "sliders-horizontal" (Mixer-Style). Sauberer
 * + lesbarer als ein Zahnrad bei kleiner Groesse. Universell als
 * "Einstellungen" verstanden.
 */
function makeWrenchIcon(): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  // 3 horizontale Schieberegler-Reihen, je 1 Knopf an unterschiedlicher
  // Position. Klar lesbar bei 16-20px.
  const paths = [
    'M21 4H8 M6 4H3',     // top row: line, gap, line
    'M21 12H10 M6 12H3',  // mid row
    'M21 20H16 M12 20H3', // bot row
    'M7 4v-2 M7 4v2 M7 4 M11 12v-2 M11 12v2 M11 12 M14 20v-2 M14 20v2 M14 20',
  ];
  // Vereinfacht: nur die 3 Linien + 3 Kreise als Knoepfe
  const linesAndKnobs = [
    // 3 horizontal lines
    'M3 6h18',
    'M3 12h18',
    'M3 18h18',
    // 3 knobs (kleine Kreise mit r=2)
    'M9 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
    'M15 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
    'M7 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
  ];
  void paths;
  for (const d of linesAndKnobs) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

function makeTrashIcon(): SVGElement {
  return makeSvgIcon('M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6 M10 11v6 M14 11v6');
}

/**
 * Subscription-Toggle als CSS-Switch (label umschliesst hidden checkbox +
 * .toggle-slider). Click-Event auf das wrap fired toggle-callback.
 */
function makeSubscriptionToggle(
  enabled: boolean,
  serverName: string,
  onToggle: (enabled: boolean) => void,
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = `toggle-switch ${enabled ? 'is-on' : 'is-off'}`;
  wrap.setAttribute('aria-label', enabled ? `${serverName} deaktivieren` : `${serverName} aktivieren`);
  wrap.title = enabled ? 'Server ist aktiv — klicken zum Deaktivieren' : 'Server ist aus — klicken zum Aktivieren';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = enabled;
  input.className = 'toggle-switch-input';
  const slider = document.createElement('span');
  slider.className = 'toggle-switch-slider';
  slider.setAttribute('aria-hidden', 'true');
  wrap.appendChild(input);
  wrap.appendChild(slider);
  // click auf label triggert input.change — wir hooken auf change statt click
  // damit Tastatur-Bedienung (Space) auch funktioniert.
  input.addEventListener('change', (ev) => {
    ev.stopPropagation();
    onToggle(input.checked);
  });
  // Stop propagation: details-summary wuerde sonst die Card aufklappen.
  wrap.addEventListener('click', (ev) => ev.stopPropagation());
  return wrap;
}

// ─────────────────────────────────────────────────────────────────────────
// Tool-Rendering Helpers
// ─────────────────────────────────────────────────────────────────────────

function sensitivityClass(s: 'read' | 'write' | 'danger'): string {
  return `tool-sens tool-sens-${s}`;
}

function sensitivityLabel(s: 'read' | 'write' | 'danger'): string {
  switch (s) {
    case 'read':
      return 'READ';
    case 'write':
      return 'WRITE';
    case 'danger':
      return 'DANGER';
  }
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

function renderToolRow(t: InventoryNativeTool | InventoryGatewayTool): HTMLElement {
  const li = document.createElement('li');
  li.className = 'tool-row';

  const head = document.createElement('div');
  head.className = 'tool-row-head';

  const badge = document.createElement('span');
  badge.className = sensitivityClass(t.sensitivity);
  badge.textContent = sensitivityLabel(t.sensitivity);
  head.appendChild(badge);

  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = t.name;
  head.appendChild(name);

  li.appendChild(head);

  if (t.description) {
    const desc = document.createElement('div');
    desc.className = 'tool-desc muted small';
    desc.textContent = t.description;
    li.appendChild(desc);
  }
  return li;
}

interface ServerSection {
  readonly name: string;
  readonly displayName: string;
  readonly subtitle: string;
  readonly tools: ReadonlyArray<InventoryNativeTool | InventoryGatewayTool>;
  readonly enabled: boolean;
  readonly isGateway: boolean;
  readonly requiredCredentials: ReadonlyArray<InventoryRequiredCredential>;
  /** Phase 4: TRUE wenn user-owned (Delete-Button anbieten). */
  readonly isUserOwned: boolean;
}

interface ServerCardCallbacks {
  readonly onRefresh?: (name: string | null) => Promise<void>;
  /**
   * Toggle Subscription. Nur für Sub-MCP-Gateways die NICHT 'native' oder
   * 'knowledge2' sind. true = aktivieren, false = deaktivieren.
   */
  readonly onToggleSubscription?: (name: string, enabled: boolean) => Promise<void>;
  /** Phase 4: User-owned Server endgueltig loeschen. */
  readonly onDelete?: (name: string) => Promise<void>;
}

/**
 * Per-Gateway-Credential-Status. Wenn requiredCredentials non-empty:
 *   - alle Provider sind im credentials-store vorhanden → ✓ Konfiguriert
 *   - mindestens einer fehlt → ⚠ Nicht konfiguriert (mit Quick-Link)
 */
function renderCredentialStatus(
  required: ReadonlyArray<InventoryRequiredCredential>,
  haveProviders: ReadonlySet<string>,
): HTMLElement | null {
  if (required.length === 0) return null;
  const missing = required.filter((rc) => !haveProviders.has(rc.provider));
  const wrap = document.createElement('div');
  wrap.className = 'server-card-creds';

  const label = document.createElement('span');
  label.className = 'server-card-creds-label muted small';
  label.textContent = `Benötigt: ${required.map((rc) => rc.provider).join(', ')}`;
  wrap.appendChild(label);

  const statusPill = document.createElement('span');
  if (missing.length === 0) {
    statusPill.className = 'pill pill-ok';
    statusPill.textContent = '✓ Konfiguriert';
  } else {
    statusPill.className = 'pill pill-warn';
    statusPill.textContent = `⚠ ${missing.length} fehlt${missing.length > 1 ? 'en' : ''}`;
  }
  wrap.appendChild(statusPill);

  if (missing.length > 0) {
    const link = document.createElement('a');
    link.href = `#/tools/credentials?add=${encodeURIComponent(missing[0]?.provider ?? '')}`;
    link.className = 'btn btn-secondary btn-small server-card-creds-add';
    link.textContent = 'Credential hinzufügen';
    wrap.appendChild(link);
  }
  return wrap;
}

function renderServerCard(
  s: ServerSection,
  cb: ServerCardCallbacks,
  haveProviders: ReadonlySet<string>,
): HTMLElement {
  const details = document.createElement('details');
  details.className = 'server-card card';

  const summary = document.createElement('summary');
  summary.className = 'server-card-summary';

  const titleRow = document.createElement('div');
  titleRow.className = 'server-card-title-row';

  // ─── Actions LINKS ───
  // Reihenfolge: [Toggle] [⚙ Konfig] [↻ Refresh] [🗑 Delete-wenn-userOwned]
  // Native + knowledge2: nur Konfig (Tool-Defaults), kein Toggle/Delete.
  const actions = document.createElement('div');
  actions.className = 'server-card-actions';

  if (s.isGateway && s.name !== 'knowledge2' && cb.onToggleSubscription) {
    const toggle = makeSubscriptionToggle(s.enabled, s.displayName, (next) => {
      if (!next && !window.confirm(`${s.displayName} deaktivieren? Tools verschwinden aus deiner Liste.`)) {
        // User abgebrochen — togglen wir das checkbox-state zurueck:
        const input = toggle.querySelector<HTMLInputElement>('.toggle-switch-input');
        if (input) input.checked = true;
        toggle.classList.remove('is-off');
        toggle.classList.add('is-on');
        return;
      }
      void cb.onToggleSubscription?.(s.name, next);
    });
    actions.appendChild(toggle);
  }

  if (s.isGateway) {
    const configLink = document.createElement('a');
    // Phase B: Detail-Page (Übersicht/Auth/Tool-Defaults/Diagnostik) als
    // One-Stop-Shop, statt Legacy-Drawer #/tools/servers/<name>/config.
    configLink.href = `#/tools/servers/${encodeURIComponent(s.name)}`;
    configLink.className = 'btn btn-icon btn-config server-card-config';
    configLink.setAttribute('aria-label', `${s.displayName} konfigurieren`);
    configLink.title = 'Konfigurieren (Tokens, OAuth, Tool-Defaults, Diagnose)';
    configLink.appendChild(makeWrenchIcon());
    configLink.addEventListener('click', (ev) => {
      ev.stopPropagation(); // <details>-Toggle nicht triggern
    });
    actions.appendChild(configLink);
  }

  if (s.isGateway && cb.onRefresh) {
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'btn btn-icon btn-refresh server-card-refresh';
    refreshBtn.setAttribute('aria-label', `Tools von ${s.displayName} neu entdecken`);
    refreshBtn.title = `Tools neu entdecken`;
    refreshBtn.appendChild(makeRefreshIcon());
    refreshBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void cb.onRefresh?.(s.name);
    });
    actions.appendChild(refreshBtn);
  }

  // Phase 4: User-owned Server endgueltig loeschen. Nur sichtbar wenn isUserOwned.
  if (s.isGateway && s.isUserOwned && cb.onDelete) {
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-icon btn-danger server-card-delete';
    deleteBtn.setAttribute('aria-label', `${s.displayName} loeschen`);
    deleteBtn.title = `${s.displayName} aus deiner Hub-Instance entfernen (irreversibel)`;
    deleteBtn.appendChild(makeTrashIcon());
    deleteBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const ok = window.confirm(
        `${s.displayName} (${s.name}) wirklich loeschen?\n\n` +
          `Alle Tokens / OAuth-Refresh / Subscription wird mit-geloescht. ` +
          `Diese Aktion ist nicht umkehrbar.`,
      );
      if (!ok) return;
      void cb.onDelete?.(s.name);
    });
    actions.appendChild(deleteBtn);
  }

  titleRow.appendChild(actions);

  const title = document.createElement('span');
  title.className = 'server-card-title';
  title.textContent = s.displayName;
  titleRow.appendChild(title);

  const count = document.createElement('span');
  count.className = 'pill';
  count.textContent = `${s.tools.length} tools`;
  titleRow.appendChild(count);

  if (!s.enabled && s.isGateway && s.name !== 'knowledge2') {
    const disabled = document.createElement('span');
    disabled.className = 'pill pill-muted';
    disabled.textContent = 'aus';
    titleRow.appendChild(disabled);
  }

  summary.appendChild(titleRow);

  const sub = document.createElement('div');
  sub.className = 'server-card-sub muted small';
  sub.textContent = s.subtitle;
  summary.appendChild(sub);

  const credsRow = renderCredentialStatus(s.requiredCredentials, haveProviders);
  if (credsRow) summary.appendChild(credsRow);

  details.appendChild(summary);

  if (s.tools.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted small server-card-empty';
    empty.textContent = 'Keine Tools registriert (oder Discovery-Cache leer).';
    details.appendChild(empty);
  } else {
    const ul = document.createElement('ul');
    ul.className = 'tool-list';
    for (const t of s.tools) ul.appendChild(renderToolRow(t));
    details.appendChild(ul);
  }

  return details;
}

function sectionsFromInventory(inv: InventoryResponse): ServerSection[] {
  const sections: ServerSection[] = [];
  sections.push({
    name: 'native',
    displayName: 'Native (mcp-approval2)',
    subtitle: `Hub-eigene Tools (User-/System-Funktionen, keine externe Anbindung)`,
    tools: inv.native,
    enabled: true,
    isGateway: false,
    requiredCredentials: [],
    isUserOwned: false,
  });
  for (const g of inv.gateways) {
    sections.push({
      name: g.name,
      displayName: g.displayName || g.name,
      subtitle: `MCP-Server · Tool-Cache ${fmtCachedAt(g.toolsCachedAt)}` +
        (g.isUserOwned ? ' · eigener Server' : ''),
      tools: g.tools,
      enabled: g.enabled,
      isGateway: true,
      requiredCredentials: g.requiredCredentials ?? [],
      isUserOwned: g.isUserOwned === true,
    });
  }
  return sections;
}

function renderRediscoverResult(r: RediscoverGatewaysResponse): string {
  const errors = r.results.filter((x) => x.error);
  const ok = r.results.filter((x) => !x.error);
  const okLabel = ok.map((x) => `${x.subMcpName}=${x.count}`).join(', ') || '-';
  const errLabel = errors.length > 0
    ? ` · ${errors.length} Fehler: ${errors.map((e) => `${e.subMcpName} (${e.error ?? 'unbekannt'})`).join(', ')}`
    : '';
  return `+${r.registered} −${r.deregistered} (${okLabel})${errLabel}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Servers Sub-View
// ─────────────────────────────────────────────────────────────────────────

async function renderServersView(
  main: HTMLElement,
  api: ApiClient,
  session: Session,
  onSessionExpired: () => void,
): Promise<void> {
  const desc = document.createElement('p');
  desc.className = 'muted';
  desc.textContent =
    'Inventur aller registrierten Tools. Native Hub-Tools plus angebundene MCP-Server. ' +
    'Sensitivity-Badge zeigt Approval-Anforderung: READ direkt, WRITE/DANGER per Approval-Gate.';
  main.appendChild(desc);

  // Toolbar mit globalem Refresh-Button (admin-only) + Server-Add.
  const toolbar = document.createElement('div');
  toolbar.className = 'tools-toolbar';
  let refreshAllBtn: HTMLButtonElement | null = null;
  const status = document.createElement('span');
  status.className = 'muted small tools-toolbar-status';

  // Add-Server-Knopf (Phase 4) — jeder User darf eigene MCP-Server anlegen.
  const addServerLink = document.createElement('a');
  addServerLink.href = '#/tools/servers/new';
  addServerLink.className = 'btn btn-primary btn-small';
  addServerLink.textContent = '+ Server hinzufügen';
  addServerLink.title = 'Eigenen MCP-Server zur Hub-Instance hinzufuegen';
  toolbar.appendChild(addServerLink);

  if (session.role === 'admin') {
    refreshAllBtn = document.createElement('button');
    refreshAllBtn.type = 'button';
    refreshAllBtn.className = 'btn btn-refresh btn-small';
    refreshAllBtn.appendChild(makeRefreshIcon());
    const lbl = document.createElement('span');
    lbl.textContent = 'Gateways neu entdecken';
    refreshAllBtn.appendChild(lbl);
    refreshAllBtn.title =
      'Aktualisiert Sub-MCP-Tool-Cache + registriert live neu in der Tool-Registry. ' +
      'Kein approval2-Restart noetig.';
    toolbar.appendChild(refreshAllBtn);
  }
  toolbar.appendChild(status);
  main.appendChild(toolbar);

  const listHost = document.createElement('div');
  listHost.className = 'server-list';
  main.appendChild(listHost);

  const footerHost = document.createElement('p');
  footerHost.className = 'muted small tools-footer';
  main.appendChild(footerHost);

  async function loadAndRender(): Promise<void> {
    listHost.replaceChildren(
      Object.assign(document.createElement('p'), {
        className: 'muted',
        textContent: 'Lade Inventar…',
      }),
    );
    footerHost.textContent = '';

    let inv: InventoryResponse;
    let creds: CredentialMeta[];
    try {
      [inv, creds] = await Promise.all([
        api.listInventory(),
        api.listCredentials().catch(() => [] as CredentialMeta[]),
      ]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onSessionExpired();
        return;
      }
      const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
      listHost.replaceChildren(
        Object.assign(document.createElement('p'), {
          className: 'err',
          textContent: `Inventar laden fehlgeschlagen: ${msg}`,
        }),
      );
      return;
    }

    // Render-Phase: ab hier sind alle Fetches done. Wenn der inv-Body nicht
    // die erwartete Shape hat (z.B. Server-Drift bei Schema-Aenderungen),
    // throwen die Accessors unten — wir wrappen in try/catch damit
    // "Lade Inventar…" nicht stehen bleibt.
    try {
    const safeInv: InventoryResponse = {
      native: Array.isArray(inv?.native) ? inv.native : [],
      gateways: Array.isArray(inv?.gateways) ? inv.gateways : [],
      available: Array.isArray(inv?.available) ? inv.available : [],
    };
    const haveProviders = new Set(creds.map((c) => c.provider));
    const sections = sectionsFromInventory(safeInv);
    listHost.replaceChildren();
    for (const s of sections) {
      listHost.appendChild(
        renderServerCard(
          s,
          {
            onRefresh: handleRefresh,
            onToggleSubscription: handleToggleSubscription,
            onDelete: handleDelete,
          },
          haveProviders,
        ),
      );
    }

    // Verfuegbar-Section: Catalog-Defaults die der User noch nicht aktiviert
    // hat. Render je Card als kompakte Box mit [Aktivieren]-Knopf.
    if (safeInv.available && safeInv.available.length > 0) {
      const availHeader = document.createElement('h2');
      availHeader.className = 'tools-available-header';
      availHeader.textContent = 'Verfügbar';
      listHost.appendChild(availHeader);
      const availDesc = document.createElement('p');
      availDesc.className = 'muted small';
      availDesc.textContent =
        'Diese MCP-Server sind verkabelt aber noch nicht von dir aktiviert. ' +
        'Aktivieren bringt die Tools in deine Liste — Tokens / OAuth musst du danach konfigurieren.';
      listHost.appendChild(availDesc);

      for (const av of safeInv.available) {
        const card = document.createElement('section');
        card.className = 'card available-server-card';

        const head = document.createElement('div');
        head.className = 'available-server-card-head';
        const title = document.createElement('strong');
        title.textContent = av.displayName;
        head.appendChild(title);
        const pill = document.createElement('span');
        pill.className = 'pill';
        pill.textContent = `${av.toolsCount} tools`;
        head.appendChild(pill);
        card.appendChild(head);

        if (av.requiredCredentials.length > 0) {
          const sub = document.createElement('div');
          sub.className = 'muted small';
          sub.textContent = `Benötigt: ${av.requiredCredentials.map((c) => c.provider).join(', ')}`;
          card.appendChild(sub);
        }

        const enableBtn = document.createElement('button');
        enableBtn.type = 'button';
        enableBtn.className = 'btn btn-primary btn-small';
        enableBtn.textContent = 'Aktivieren';
        enableBtn.addEventListener('click', () => {
          void handleToggleSubscription(av.name, true);
        });
        card.appendChild(enableBtn);

        listHost.appendChild(card);
      }
    }

    const total =
      safeInv.native.length +
      safeInv.gateways.reduce((a, g) => a + (g.tools?.length ?? 0), 0);
    const availableCount = safeInv.available?.length ?? 0;
    footerHost.textContent =
      `Gesamt: ${total} Tools über ${1 + safeInv.gateways.length} aktivierte Server` +
      (availableCount > 0 ? ` · ${availableCount} weitere verfügbar` : '');
    } catch (renderErr) {
      // Render-Pfad ist hard-failed. "Lade Inventar…"-Placeholder mit Fehler
      // ueberschreiben damit der User nicht im Limbo haengt.
      console.error('inventory render failed', renderErr, inv, creds);
      listHost.replaceChildren(
        Object.assign(document.createElement('p'), {
          className: 'err',
          textContent: `Inventar-Rendering fehlgeschlagen: ${(renderErr as Error).message ?? String(renderErr)}`,
        }),
      );
    }
  }

  async function handleDelete(name: string): Promise<void> {
    status.classList.remove('err');
    status.textContent = `Loesche ${name}…`;
    try {
      await api.deleteUserServer(name);
      status.textContent = `${name} geloescht.`;
      await loadAndRender();
    } catch (err) {
      status.classList.add('err');
      if (err instanceof ApiError && err.status === 401) {
        onSessionExpired();
        return;
      }
      const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
      status.textContent = `Loeschen fehlgeschlagen: ${msg}`;
    }
  }

  async function handleToggleSubscription(name: string, enabled: boolean): Promise<void> {
    status.classList.remove('err');
    status.textContent = enabled ? `Aktiviere ${name}…` : `Deaktiviere ${name}…`;
    try {
      await api.setServerSubscription(name, enabled);
      status.textContent = enabled ? `${name} aktiviert.` : `${name} deaktiviert.`;
      await loadAndRender();
    } catch (err) {
      status.classList.add('err');
      if (err instanceof ApiError && err.status === 401) {
        onSessionExpired();
        return;
      }
      const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
      status.textContent = `Fehler: ${msg}`;
    }
  }

  async function handleRefresh(name: string | null): Promise<void> {
    if (refreshAllBtn) {
      refreshAllBtn.disabled = true;
      refreshAllBtn.classList.add('is-loading');
    }
    const perCardBtns = Array.from(
      listHost.querySelectorAll<HTMLButtonElement>('.server-card-refresh'),
    );
    for (const b of perCardBtns) {
      b.disabled = true;
      if (name && b.getAttribute('aria-label')?.includes(name)) {
        b.classList.add('is-loading');
      }
    }
    status.classList.remove('err');
    status.textContent = name ? `Aktualisiere ${name}…` : 'Aktualisiere alle Gateways…';

    try {
      const result = await api.rediscoverGateways(name ?? undefined);
      status.textContent = renderRediscoverResult(result);
      await loadAndRender();
    } catch (err) {
      status.classList.add('err');
      if (err instanceof ApiError) {
        if (err.status === 401) {
          onSessionExpired();
          return;
        }
        if (err.status === 403) {
          status.textContent = 'Refresh erlaubt nur admin-Rolle (403).';
        } else {
          status.textContent = `Refresh fehlgeschlagen: ${err.code}: ${err.message}`;
        }
      } else {
        status.textContent = `Refresh fehlgeschlagen: ${String(err)}`;
      }
    } finally {
      if (refreshAllBtn) {
        refreshAllBtn.disabled = false;
        refreshAllBtn.classList.remove('is-loading');
      }
      for (const b of listHost.querySelectorAll<HTMLButtonElement>(
        '.server-card-refresh',
      )) {
        b.disabled = false;
        b.classList.remove('is-loading');
      }
    }
  }

  if (refreshAllBtn) {
    refreshAllBtn.addEventListener('click', () => {
      void handleRefresh(null);
    });
  }

  await loadAndRender();
}

// ─────────────────────────────────────────────────────────────────────────
// Credentials Sub-View
// ─────────────────────────────────────────────────────────────────────────

/**
 * Liest `?add=<provider>` aus dem aktuellen Hash (z.B.
 * `#/tools/credentials?add=google-workspace`).
 */
function parseAutoOpenProvider(): string | undefined {
  const hash = window.location.hash;
  const qIdx = hash.indexOf('?');
  if (qIdx < 0) return undefined;
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  const v = params.get('add');
  return v && v.length > 0 ? v : undefined;
}

/**
 * Slots aus dem Inventar bauen: pro Provider den Gateway-Display-Namen
 * sammeln der ihn deklariert. So weiss der User "Benötigt für: gws".
 *
 * Sammelt aus aktivierten gateways UND available-(noch-nicht-aktivierten)
 * Servern — damit User Tokens vorab konfigurieren kann.
 */
function buildSlotsFromInventory(inv: InventoryResponse): CredentialSlot[] {
  const byProvider = new Map<string, { kind: string | null; usedBy: string[] }>();
  const collect = (name: string, displayName: string, reqs: ReadonlyArray<InventoryRequiredCredential>) => {
    for (const rc of reqs ?? []) {
      const existing = byProvider.get(rc.provider);
      const usedByName = displayName || name;
      if (!existing) {
        byProvider.set(rc.provider, {
          kind: rc.kind ?? null,
          usedBy: [usedByName],
        });
      } else {
        if (!existing.usedBy.includes(usedByName)) existing.usedBy.push(usedByName);
        if (existing.kind === null && rc.kind !== null) existing.kind = rc.kind;
      }
    }
  };
  for (const gw of inv.gateways ?? []) {
    collect(gw.name, gw.displayName, gw.requiredCredentials);
  }
  for (const av of inv.available ?? []) {
    collect(av.name, av.displayName, av.requiredCredentials);
  }
  return [...byProvider.entries()]
    .map(([provider, v]) => ({ provider, kind: v.kind, usedBy: v.usedBy }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

async function renderCredentialsView(
  main: HTMLElement,
  api: ApiClient,
): Promise<void> {
  const body = document.createElement('div');
  body.className = 'tools-credentials';
  main.appendChild(body);

  // Inventar zuerst — wir brauchen die declared-credentials pro Server.
  let inv: InventoryResponse;
  try {
    inv = await api.listInventory();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      throw err;
    }
    const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
    body.replaceChildren(
      Object.assign(document.createElement('p'), {
        className: 'err',
        textContent: `Inventar laden fehlgeschlagen: ${msg}`,
      }),
    );
    return;
  }

  const slots = buildSlotsFromInventory(inv);
  const autoOpen = parseAutoOpenProvider();
  await renderCredentialsDeclaredView(body, api, slots, autoOpen);
}

// ─────────────────────────────────────────────────────────────────────────
// Main Dispatcher
// ─────────────────────────────────────────────────────────────────────────

export async function renderToolsTab(
  root: HTMLElement,
  api: ApiClient,
  session: Session,
): Promise<void> {
  root.replaceChildren();
  renderHeader(root, session, () => void logout(api));

  const main = document.createElement('main');
  main.className = 'tools-tab';

  const h1 = document.createElement('h1');
  h1.textContent = 'Tools & Servers';
  main.appendChild(h1);

  const active = parseToolsSubTab();
  main.appendChild(renderSubNav(active));

  root.appendChild(main);

  try {
    if (active === 'credentials') {
      await renderCredentialsView(main, api);
    } else {
      await renderServersView(main, api, session, () => renderSessionExpired(root));
    }
  } catch (err) {
    console.error('tools render failed', err);
    renderSessionExpired(root);
  }
}

