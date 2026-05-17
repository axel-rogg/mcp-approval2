/**
 * Tools-Tab — Read-only Inventur aller registrierten Tools + Sub-MCP-Gateways.
 *
 * Routes:
 *   #/tools  → Hub-View mit Server-Cards (native + Gateways)
 *
 * Pattern aus v1-mcp-approval `#/servers` portiert: Server-Liste mit Expand/
 * Collapse, pro Tool Sensitivity-Badge (read/write/danger).
 */
import type {
  ApiClient,
  InventoryGatewayTool,
  InventoryNativeTool,
  InventoryResponse,
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
}

function renderServerCard(s: ServerSection): HTMLElement {
  const details = document.createElement('details');
  details.className = 'server-card card';
  // Native default offen, Gateways default collapsed
  if (s.name === 'native') details.open = true;

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
  });
  for (const g of inv.gateways) {
    sections.push({
      name: g.name,
      displayName: g.displayName || g.name,
      subtitle: `Gateway · Tool-Cache ${fmtCachedAt(g.toolsCachedAt)}`,
      tools: g.tools,
      enabled: g.enabled,
    });
  }
  return sections;
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
    'Read-only Inventur aller registrierten Tools. Native Hub-Tools plus angebundene Sub-MCP-Gateways. ' +
    'Sensitivity-Badge zeigt Approval-Anforderung: READ direkt, WRITE/DANGER per Approval-Gate.';
  main.appendChild(desc);

  const listHost = document.createElement('div');
  listHost.className = 'server-list';
  main.appendChild(listHost);

  root.appendChild(main);

  // Loading-Indikator
  listHost.replaceChildren(
    Object.assign(document.createElement('p'), {
      className: 'muted',
      textContent: 'Lade Inventar…',
    }),
  );

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
  for (const s of sections) listHost.appendChild(renderServerCard(s));

  // Footer mit Gesamt-Counts
  const total = inv.native.length + inv.gateways.reduce((a, g) => a + g.tools.length, 0);
  const footer = document.createElement('p');
  footer.className = 'muted small tools-footer';
  footer.textContent = `Gesamt: ${total} Tools über ${1 + inv.gateways.length} Server`;
  main.appendChild(footer);
}
