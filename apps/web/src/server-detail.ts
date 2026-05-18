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

interface OAuthMeta {
  readonly provider?: string;
  readonly kind?: 'pre' | 'dcr';
  readonly scopes?: ReadonlyArray<string>;
  readonly help_url?: string;
}

interface ConfigSchemaMeta {
  readonly oauth?: OAuthMeta;
  readonly auth_mode?: 'service_bearer' | 'oauth' | 'api_token';
}

type AuthMode = 'service_bearer' | 'oauth' | 'api_token' | 'none';

function detectAuthMode(gw: InventoryGateway | null): { mode: AuthMode; oauth?: OAuthMeta } {
  if (!gw) return { mode: 'none' };
  const schema = (gw.configSchema as ConfigSchemaMeta | undefined) ?? {};
  if (schema.oauth) return { mode: 'oauth', oauth: schema.oauth };
  if (schema.auth_mode === 'api_token') return { mode: 'api_token' };
  if (schema.auth_mode === 'service_bearer') return { mode: 'service_bearer' };
  // Defaults: requires_credential mit kind=oauth_refresh → oauth.
  const oauthReq = gw.requiredCredentials?.find((r) => r.kind === 'oauth_refresh');
  if (oauthReq) {
    return { mode: 'oauth', oauth: { provider: oauthReq.provider, kind: 'pre' } };
  }
  return { mode: 'service_bearer' };
}

async function renderAuthTab(
  body: HTMLElement,
  api: ApiClient,
  serverName: string,
  gw: InventoryGateway | null,
): Promise<void> {
  const { mode, oauth } = detectAuthMode(gw);
  const card = document.createElement('section');
  card.className = 'card server-detail-section';

  const h = document.createElement('h2');
  h.textContent = 'Authentifizierung';
  card.appendChild(h);

  if (mode === 'none') {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Dieser Server ist nicht abonniert. Aktiviere ihn zuerst in der Übersicht.';
    card.appendChild(p);
    body.appendChild(card);
    return;
  }

  const modeBadge = document.createElement('span');
  modeBadge.className = 'pill';
  modeBadge.textContent =
    mode === 'oauth'
      ? `OAuth 2.0${oauth?.provider ? ` · ${oauth.provider}` : ''}`
      : mode === 'api_token'
        ? 'API-Token (PAT)'
        : 'Service-Bearer (Shared-Token)';
  modeBadge.style.marginBottom = '0.6rem';
  card.appendChild(modeBadge);

  // Aktuelle Configs laden (mit 404 = leer)
  let cfg: { fields: Record<string, { value: string; isSecret: boolean }> } | null = null;
  try {
    cfg = await api.getServerConfig(serverName);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) {
      const p = document.createElement('p');
      p.className = 'err';
      p.textContent = `Config laden fehlgeschlagen: ${(err as Error).message}`;
      card.appendChild(p);
      body.appendChild(card);
      return;
    }
  }

  if (mode === 'oauth') {
    await renderOAuthFlow(card, api, serverName, cfg, oauth);
  } else if (mode === 'api_token') {
    renderTokenForm(card, api, serverName, cfg, '_api_token', 'API-Token / PAT');
  } else {
    renderTokenForm(card, api, serverName, cfg, '_service_token', 'Service-Token');
  }

  body.appendChild(card);
}

function renderTokenForm(
  card: HTMLElement,
  api: ApiClient,
  serverName: string,
  cfg: { fields: Record<string, { value: string; isSecret: boolean }> } | null,
  configKey: string,
  label: string,
): void {
  const desc = document.createElement('p');
  desc.className = 'muted small';
  desc.textContent =
    `Hinterlege den Token für ${serverName}. Wird KMS-encrypted gespeichert (AES-256-GCM, per-row DEK).`;
  card.appendChild(desc);

  const existing = cfg?.fields[configKey];
  const form = document.createElement('form');
  form.className = 'form';

  const wrap = document.createElement('div');
  wrap.className = 'field';
  const lbl = document.createElement('label');
  lbl.htmlFor = `tokenInput-${configKey}`;
  lbl.textContent = label;
  wrap.appendChild(lbl);
  const input = document.createElement('input');
  input.id = `tokenInput-${configKey}`;
  input.type = 'password';
  input.autocomplete = 'new-password';
  input.placeholder = existing
    ? '••••••• (gesetzt — neuer Wert ersetzt)'
    : 'Token einfügen…';
  wrap.appendChild(input);
  form.appendChild(wrap);

  if (existing) {
    const note = document.createElement('p');
    note.className = 'ok small';
    note.textContent = '✓ Token bereits gesetzt.';
    form.appendChild(note);
  }

  const row = document.createElement('div');
  row.className = 'row form-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = 'Speichern';
  row.appendChild(saveBtn);
  if (existing) {
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-secondary btn-danger';
    delBtn.textContent = 'Löschen';
    delBtn.addEventListener('click', async () => {
      if (!window.confirm('Token entfernen? Server-Forward bricht.')) return;
      try {
        await api.deleteServerConfig(serverName, configKey);
        showToast('Token entfernt.', 'success');
        // re-render parent
        window.location.hash = `#/tools/servers/${encodeURIComponent(serverName)}/auth`;
        window.location.reload();
      } catch (err) {
        showToast(`Fehler: ${(err as Error).message}`, 'error');
      }
    });
    row.appendChild(delBtn);
  }
  const status = document.createElement('span');
  status.className = 'muted small';
  row.appendChild(status);
  form.appendChild(row);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!input.value) {
      status.textContent = 'Bitte Token eingeben.';
      status.className = 'err small';
      return;
    }
    saveBtn.disabled = true;
    status.textContent = 'Speichere…';
    status.className = 'muted small';
    try {
      await api.setServerConfig(serverName, configKey, input.value);
      status.textContent = '✓ Gespeichert';
      status.className = 'ok small';
      input.value = '';
      input.placeholder = '••••••• (gesetzt — neuer Wert ersetzt)';
    } catch (err) {
      status.textContent = `Fehler: ${(err as Error).message}`;
      status.className = 'err small';
    } finally {
      saveBtn.disabled = false;
    }
  });

  card.appendChild(form);
}

/**
 * Defensive Help-URL-Renderer: nur als <a> rendern wenn `value` eine gueltige
 * absolute URL ist und keine Whitespaces enthaelt. Sonst Plain-Text Paragraph.
 * Hintergrund: legacy-DB-Eintraege haben help_url als ganzen Satz inkl. URL
 * gespeichert ("https://… — OAuth-Client-ID erzeugen, Type …"), das ergab
 * kaputte <a href="ganzer satz">-Tags.
 */
function renderHelpUrl(card: HTMLElement, value: string, label: string): void {
  const p = document.createElement('p');
  p.className = 'muted small';
  const trimmed = value.trim();
  const looksLikeUrl =
    /^https?:\/\/\S+$/.test(trimmed) && (() => {
      try {
        new URL(trimmed);
        return true;
      } catch {
        return false;
      }
    })();
  if (looksLikeUrl) {
    const a = document.createElement('a');
    a.href = trimmed;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = `${label}: ${trimmed}`;
    p.appendChild(a);
  } else {
    // Plain-Text-Fallback fuer kaputte Eintraege oder Satz-Hinweise
    p.textContent = `${label}: ${trimmed}`;
  }
  card.appendChild(p);
}

async function renderOAuthFlow(
  card: HTMLElement,
  api: ApiClient,
  serverName: string,
  cfg: { fields: Record<string, { value: string; isSecret: boolean }> } | null,
  oauth?: OAuthMeta,
): Promise<void> {
  const isDcr = oauth?.kind === 'dcr';
  const refreshTokenField = cfg?.fields['_oauth_refresh_token'];

  const desc = document.createElement('p');
  desc.className = 'muted small';
  desc.textContent = isDcr
    ? 'Dynamic Client Registration (DCR, RFC 7591): beim Klick auf Authorize ' +
      'registrieren wir einen eigenen OAuth-Client beim Provider. Du musst nichts eintragen. ' +
      'Refresh-Token wird KMS-encrypted gespeichert.'
    : 'Pre-registered OAuth 2.0: trage Client-ID + Client-Secret deiner OAuth-App ein, ' +
      'dann starte den Authorize-Flow. Refresh-Token wird KMS-encrypted gespeichert.';
  card.appendChild(desc);

  if (oauth?.help_url) {
    renderHelpUrl(card, oauth.help_url, 'Setup-Hilfe');
  }
  if (oauth?.scopes && oauth.scopes.length > 0) {
    const scopesP = document.createElement('p');
    scopesP.className = 'muted small';
    scopesP.textContent = `Scopes: ${oauth.scopes.join(', ')}`;
    card.appendChild(scopesP);
  }

  // Pre-registered: User muss client_id/secret selbst eintragen.
  // DCR: client_id/secret werden serverseitig beim ersten Authorize erzeugt
  //      und in user_sub_mcp_config gespeichert — kein Input-Form noetig.
  if (!isDcr) {
    renderClientCredentialsForm(card, api, serverName, cfg);
  } else if (cfg?.fields['_oauth_client_id']) {
    const regInfo = document.createElement('p');
    regInfo.className = 'muted small';
    regInfo.textContent =
      '✓ DCR-Client bereits registriert. Re-Authorize benutzt denselben Client.';
    card.appendChild(regInfo);
  }

  // Authorize-Flow (gemeinsam fuer pre + dcr)
  const statusLine = document.createElement('p');
  if (refreshTokenField) {
    statusLine.className = 'ok small';
    statusLine.textContent = '✓ Authorisiert — Refresh-Token gespeichert (KMS-encrypted).';
  } else {
    statusLine.className = 'muted small';
    statusLine.textContent = isDcr
      ? '⚠ Noch nicht authorisiert. Klicke Authorize — wir registrieren den DCR-Client und leiten dich zum Provider.'
      : '⚠ Noch nicht authorisiert. Speichere zuerst Client-ID + Client-Secret oben, dann klicke Authorize.';
  }
  card.appendChild(statusLine);

  const authzBox = document.createElement('div');
  authzBox.className = 'server-detail-action-row';
  authzBox.style.marginTop = '1rem';
  const authzBtn = document.createElement('button');
  authzBtn.type = 'button';
  authzBtn.className = 'btn btn-primary btn-small';
  authzBtn.textContent = refreshTokenField ? '▶ Re-Authorize' : '▶ Authorize';
  const authzStatus = document.createElement('span');
  authzStatus.className = 'muted small';

  authzBtn.addEventListener('click', async () => {
    authzBtn.disabled = true;
    authzStatus.textContent = isDcr
      ? 'Registriere DCR-Client + generiere Authorize-URL…'
      : 'Generiere Authorize-URL…';
    authzStatus.className = 'muted small';
    try {
      const redirectUri = `${window.location.origin}/#/tools/servers/${encodeURIComponent(serverName)}/oauth/callback`;
      const { authorizeUrl } = await api.startServerOAuth(serverName, redirectUri);
      authzStatus.textContent = 'Leite zu Provider…';
      window.location.href = authorizeUrl;
    } catch (err) {
      authzStatus.textContent = `Fehler: ${(err as Error).message}`;
      authzStatus.className = 'err small';
      authzBtn.disabled = false;
    }
  });
  authzBox.appendChild(authzBtn);
  authzBox.appendChild(authzStatus);
  card.appendChild(authzBox);
}

function renderClientCredentialsForm(
  card: HTMLElement,
  api: ApiClient,
  serverName: string,
  cfg: { fields: Record<string, { value: string; isSecret: boolean }> } | null,
): void {
  const clientIdField = cfg?.fields['_oauth_client_id'];
  const clientSecretField = cfg?.fields['_oauth_client_secret'];

  const form = document.createElement('form');
  form.className = 'form';

  const ciField = document.createElement('div');
  ciField.className = 'field';
  const ciLbl = document.createElement('label');
  ciLbl.textContent = 'Client-ID';
  ciField.appendChild(ciLbl);
  const ciInput = document.createElement('input');
  ciInput.type = 'text';
  ciInput.autocomplete = 'off';
  ciInput.placeholder = clientIdField ? '(gesetzt — neuer Wert ersetzt)' : 'z.B. 1234567890-abc.apps.googleusercontent.com';
  ciField.appendChild(ciInput);
  form.appendChild(ciField);

  const csField = document.createElement('div');
  csField.className = 'field';
  const csLbl = document.createElement('label');
  csLbl.textContent = 'Client-Secret';
  csField.appendChild(csLbl);
  const csInput = document.createElement('input');
  csInput.type = 'password';
  csInput.autocomplete = 'new-password';
  csInput.placeholder = clientSecretField
    ? '••••••• (gesetzt — neuer Wert ersetzt)'
    : 'OAuth-App Secret';
  csField.appendChild(csInput);
  form.appendChild(csField);

  const saveRow = document.createElement('div');
  saveRow.className = 'row form-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'btn btn-secondary';
  saveBtn.textContent = 'Client-Daten speichern';
  saveRow.appendChild(saveBtn);
  const saveStatus = document.createElement('span');
  saveStatus.className = 'muted small';
  saveRow.appendChild(saveStatus);
  form.appendChild(saveRow);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    saveBtn.disabled = true;
    saveStatus.textContent = 'Speichere…';
    saveStatus.className = 'muted small';
    try {
      if (ciInput.value) await api.setServerConfig(serverName, '_oauth_client_id', ciInput.value);
      if (csInput.value) await api.setServerConfig(serverName, '_oauth_client_secret', csInput.value);
      saveStatus.textContent = '✓ Gespeichert. Jetzt Authorize starten.';
      saveStatus.className = 'ok small';
      ciInput.value = '';
      csInput.value = '';
      ciInput.placeholder = '(gesetzt — neuer Wert ersetzt)';
      csInput.placeholder = '••••••• (gesetzt — neuer Wert ersetzt)';
    } catch (err) {
      saveStatus.textContent = `Fehler: ${(err as Error).message}`;
      saveStatus.className = 'err small';
    } finally {
      saveBtn.disabled = false;
    }
  });
  card.appendChild(form);
}

async function renderDefaultsTab(
  body: HTMLElement,
  api: ApiClient,
  serverName: string,
  gw: InventoryGateway | null,
): Promise<void> {
  const card = document.createElement('section');
  card.className = 'card server-detail-section';
  const h = document.createElement('h2');
  h.textContent = 'Tool-Defaults';
  card.appendChild(h);

  const desc = document.createElement('p');
  desc.className = 'muted small';
  desc.textContent =
    'Pro Tool kannst du Default-Werte hinterlegen. Sie werden automatisch in jeden ' +
    'Tool-Call eingefüllt, sofern der Caller keinen eigenen Wert übergibt.';
  card.appendChild(desc);

  if (!gw || (gw.tools?.length ?? 0) === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent =
      'Keine Tools im Cache. Aktiviere den Server + entdecke Tools neu (Übersicht), um Defaults zu setzen.';
    card.appendChild(empty);
    body.appendChild(card);
    return;
  }

  // Bestehende Defaults laden
  let existing: ReadonlyArray<import('./api.js').ToolDefault> = [];
  try {
    existing = await api.listToolDefaults(serverName);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      renderSessionExpired(document.getElementById('app') ?? document.body);
      return;
    }
    // 404 = keine Defaults gespeichert; weiter mit []
  }

  // Map: toolName -> fieldName -> value
  const valueMap = new Map<string, Map<string, string>>();
  for (const e of existing) {
    if (!valueMap.has(e.toolName)) valueMap.set(e.toolName, new Map());
    valueMap.get(e.toolName)!.set(e.fieldName, e.value);
  }

  const toolsHost = document.createElement('div');
  toolsHost.className = 'tool-defaults-list';

  for (const tool of gw.tools) {
    const block = renderToolDefaultsBlock(api, serverName, tool.name, tool.description ?? '', valueMap.get(tool.name));
    toolsHost.appendChild(block);
  }

  card.appendChild(toolsHost);
  body.appendChild(card);
}

function renderToolDefaultsBlock(
  api: ApiClient,
  serverName: string,
  toolName: string,
  toolDesc: string,
  existing: Map<string, string> | undefined,
): HTMLElement {
  const wrap = document.createElement('details');
  wrap.className = 'tool-defaults-tool card-section';
  // Erst-aufklappen wenn schon defaults existieren
  if (existing && existing.size > 0) wrap.open = true;

  const summary = document.createElement('summary');
  summary.className = 'tool-defaults-tool-head';
  const nameEl = document.createElement('span');
  nameEl.className = 'tool-name';
  nameEl.textContent = toolName;
  summary.appendChild(nameEl);
  if (existing && existing.size > 0) {
    const pill = document.createElement('span');
    pill.className = 'pill pill-ok';
    pill.textContent = `${existing.size} default${existing.size === 1 ? '' : 's'}`;
    summary.appendChild(pill);
  }
  wrap.appendChild(summary);

  if (toolDesc) {
    const desc = document.createElement('p');
    desc.className = 'muted small';
    desc.textContent = toolDesc;
    wrap.appendChild(desc);
  }

  // Render existing fields + Add-Form
  const list = document.createElement('div');
  list.className = 'tool-defaults-fields';
  if (existing) {
    for (const [field, value] of existing.entries()) {
      list.appendChild(renderDefaultRow(api, serverName, toolName, field, value));
    }
  }
  wrap.appendChild(list);

  // Add new field
  const addForm = document.createElement('form');
  addForm.className = 'tool-defaults-add-form row';
  const addField = document.createElement('input');
  addField.type = 'text';
  addField.placeholder = 'field_name';
  addField.pattern = '[a-zA-Z_][a-zA-Z0-9_]*';
  addField.required = true;
  const addValue = document.createElement('input');
  addValue.type = 'text';
  addValue.placeholder = 'default value';
  addValue.required = true;
  const addBtn = document.createElement('button');
  addBtn.type = 'submit';
  addBtn.className = 'btn btn-secondary btn-small';
  addBtn.textContent = '+ Default';
  addForm.appendChild(addField);
  addForm.appendChild(addValue);
  addForm.appendChild(addBtn);
  addForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const field = addField.value.trim();
    const value = addValue.value;
    if (!field || !value) return;
    addBtn.disabled = true;
    try {
      await api.setToolDefault(serverName, toolName, field, value);
      const row = renderDefaultRow(api, serverName, toolName, field, value);
      list.appendChild(row);
      addField.value = '';
      addValue.value = '';
      showToast('Default gesetzt.', 'success');
    } catch (err) {
      showToast(`Fehler: ${(err as Error).message}`, 'error');
    } finally {
      addBtn.disabled = false;
    }
  });
  wrap.appendChild(addForm);

  return wrap;
}

function renderDefaultRow(
  api: ApiClient,
  serverName: string,
  toolName: string,
  fieldName: string,
  currentValue: string,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tool-defaults-row';
  row.dataset['field'] = fieldName;

  const lbl = document.createElement('label');
  lbl.className = 'tool-defaults-field-name';
  lbl.textContent = fieldName;
  row.appendChild(lbl);

  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentValue;
  input.className = 'tool-defaults-value-input';
  row.appendChild(input);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-secondary btn-small';
  saveBtn.textContent = 'Speichern';
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      await api.setToolDefault(serverName, toolName, fieldName, input.value);
      showToast(`Default ${fieldName} gespeichert.`, 'success');
    } catch (err) {
      showToast(`Fehler: ${(err as Error).message}`, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });
  row.appendChild(saveBtn);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'btn btn-secondary btn-small btn-danger';
  delBtn.textContent = '×';
  delBtn.title = 'Default entfernen';
  delBtn.addEventListener('click', async () => {
    if (!window.confirm(`Default '${fieldName}' entfernen?`)) return;
    try {
      await api.deleteToolDefault(serverName, toolName, fieldName);
      row.remove();
      showToast('Default entfernt.', 'success');
    } catch (err) {
      showToast(`Fehler: ${(err as Error).message}`, 'error');
    }
  });
  row.appendChild(delBtn);

  return row;
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
      await renderAuthTab(body, api, serverName, gw);
      break;
    case 'defaults':
      await renderDefaultsTab(body, api, serverName, gw);
      break;
    case 'diagnostics':
      renderDiagnosticsTab(body, gw, serverName);
      break;
  }

  main.appendChild(body);
  root.appendChild(main);
}
