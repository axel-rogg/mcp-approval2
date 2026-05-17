/**
 * Tools-Tab — Inventur aller registrierten Tools + Sub-MCP-Gateways.
 *
 * Routes:
 *   #/tools  → Hub-View mit Server-Cards (native + Gateways)
 *
 * Pattern aus v1-mcp-approval `#/servers` portiert: Server-Liste mit Expand/
 * Collapse, pro Tool Sensitivity-Badge (read/write/danger).
 *
 * Gateway-Refresh (2026-05-17): admin sieht zusaetzlich einen "Gateways neu
 * entdecken"-Button (global) sowie pro-Gateway-Card einen kleinen Refresh-
 * Trigger. Ruft `POST /v1/admin/gateways/rediscover`, das den Tool-Cache
 * aktualisiert UND die in-memory Registry live re-registriert (analog
 * kc-manifest-refresh). Keine approval2-Restart noetig.
 */
import type {
  ApiClient,
  InventoryGatewayTool,
  InventoryNativeTool,
  InventoryResponse,
  RediscoverGatewaysResponse,
  Session,
} from './api.js';
import { ApiError } from './api.js';
import { logout, renderSessionExpired } from './auth.js';
import { renderHeader } from './components/header.js';

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
  /** Only true for sub-MCP gateways — they get a refresh affordance. */
  readonly isGateway: boolean;
}

interface ServerCardCallbacks {
  /**
   * Triggered by per-gateway refresh button. `name` ist der Gateway-Slug.
   * `null` heisst alle (vom Toolbar-Button). Callback ist optional fuer
   * non-admin renders.
   */
  readonly onRefresh?: (name: string | null) => Promise<void>;
}

function renderServerCard(s: ServerSection, cb: ServerCardCallbacks): HTMLElement {
  const details = document.createElement('details');
  details.className = 'server-card card';
  // Alle Server-Cards default eingeklappt — User-Wunsch (Inventur ist
  // Read-only-Surface, nicht Default-Workflow).

  const summary = document.createElement('summary');
  summary.className = 'server-card-summary';

  const titleRow = document.createElement('div');
  titleRow.className = 'server-card-title-row';

  const title = document.createElement('span');
  title.className = 'server-card-title';
  title.textContent = s.displayName;
  titleRow.appendChild(title);

  const count = document.createElement('span');
  count.className = 'pill';
  count.textContent = `${s.tools.length} tools`;
  titleRow.appendChild(count);

  if (!s.enabled) {
    const disabled = document.createElement('span');
    disabled.className = 'pill pill-danger';
    disabled.textContent = 'disabled';
    titleRow.appendChild(disabled);
  }

  if (s.isGateway && cb.onRefresh) {
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'btn btn-secondary btn-small server-card-refresh';
    refreshBtn.textContent = '🔄';
    refreshBtn.title = `Tools von ${s.displayName} neu entdecken`;
    refreshBtn.addEventListener('click', (ev) => {
      // Klick auf den Refresh-Button soll das <details>-Toggle nicht triggern.
      ev.preventDefault();
      ev.stopPropagation();
      void cb.onRefresh?.(s.name);
    });
    titleRow.appendChild(refreshBtn);
  }

  summary.appendChild(titleRow);

  const sub = document.createElement('div');
  sub.className = 'server-card-sub muted small';
  sub.textContent = s.subtitle;
  summary.appendChild(sub);

  details.appendChild(summary);

  if (s.tools.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted small';
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
    subtitle: `Hub-eigene Tools, inkl. KC-Wrappers wenn KC2 erreichbar`,
    tools: inv.native,
    enabled: true,
    isGateway: false,
  });
  for (const g of inv.gateways) {
    sections.push({
      name: g.name,
      displayName: g.displayName || g.name,
      subtitle: `Gateway · Tool-Cache ${fmtCachedAt(g.toolsCachedAt)}`,
      tools: g.tools,
      enabled: g.enabled,
      isGateway: true,
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

  const desc = document.createElement('p');
  desc.className = 'muted';
  desc.textContent =
    'Inventur aller registrierten Tools. Native Hub-Tools plus angebundene Sub-MCP-Gateways. ' +
    'Sensitivity-Badge zeigt Approval-Anforderung: READ direkt, WRITE/DANGER per Approval-Gate.';
  main.appendChild(desc);

  // Toolbar mit globalem Refresh-Button. Nur admins koennen das HTTP-Endpoint
  // erfolgreich aufrufen (Server-side check). Wir blenden den Knopf fuer
  // members trotzdem aus — keine 403-Verwirrung.
  const toolbar = document.createElement('div');
  toolbar.className = 'tools-toolbar';
  let refreshAllBtn: HTMLButtonElement | null = null;
  const status = document.createElement('span');
  status.className = 'muted small tools-toolbar-status';
  if (session.role === 'admin') {
    refreshAllBtn = document.createElement('button');
    refreshAllBtn.type = 'button';
    refreshAllBtn.className = 'btn btn-secondary btn-small';
    refreshAllBtn.textContent = '🔄 Gateways neu entdecken';
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

  root.appendChild(main);

  // -----------------------------------------------------------------
  // State + Reload-Helper.
  // -----------------------------------------------------------------
  async function loadAndRender(): Promise<void> {
    listHost.replaceChildren(
      Object.assign(document.createElement('p'), {
        className: 'muted',
        textContent: 'Lade Inventar…',
      }),
    );
    footerHost.textContent = '';

    let inv: InventoryResponse;
    try {
      inv = await api.listInventory();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        renderSessionExpired(root);
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

    const sections = sectionsFromInventory(inv);
    listHost.replaceChildren();
    for (const s of sections) {
      listHost.appendChild(renderServerCard(s, { onRefresh: handleRefresh }));
    }

    const total = inv.native.length + inv.gateways.reduce((a, g) => a + g.tools.length, 0);
    footerHost.textContent = `Gesamt: ${total} Tools über ${1 + inv.gateways.length} Server`;
  }

  async function handleRefresh(name: string | null): Promise<void> {
    // Lock alle relevanten Buttons + Status zeigen.
    if (refreshAllBtn) refreshAllBtn.disabled = true;
    const perCardBtns = Array.from(
      listHost.querySelectorAll<HTMLButtonElement>('.server-card-refresh'),
    );
    for (const b of perCardBtns) b.disabled = true;
    status.classList.remove('err');
    status.textContent = name
      ? `Aktualisiere ${name}…`
      : 'Aktualisiere alle Gateways…';

    try {
      const result = await api.rediscoverGateways(name ?? undefined);
      status.textContent = renderRediscoverResult(result);
      // Inventar neu laden damit Tool-Cache-Timestamps + Counts stimmen.
      await loadAndRender();
      // re-bind buttons (loadAndRender hat sie neu gemalt) — disabled-State
      // wird durch das Re-Render auto-reset.
    } catch (err) {
      status.classList.add('err');
      if (err instanceof ApiError) {
        if (err.status === 401) {
          renderSessionExpired(root);
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
      if (refreshAllBtn) refreshAllBtn.disabled = false;
    }
  }

  if (refreshAllBtn) {
    refreshAllBtn.addEventListener('click', () => {
      void handleRefresh(null);
    });
  }

  await loadAndRender();
}
