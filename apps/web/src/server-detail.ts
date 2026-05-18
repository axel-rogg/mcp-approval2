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
import {
  extractFieldsFromSchema,
  pickWidget,
  renderWidget,
} from './components/schema-form.js';

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
  readonly kind?: 'pre' | 'dcr' | 'shared-app';
  readonly scopes?: ReadonlyArray<string>;
  readonly help_url?: string;
}

interface ConfigField {
  readonly key: string;
  readonly label: string;
  readonly type?: 'text' | 'password' | 'textarea';
  readonly is_secret?: boolean;
  readonly description?: string;
}

interface ConfigSchemaMeta {
  readonly oauth?: OAuthMeta;
  readonly config_fields?: ReadonlyArray<ConfigField>;
  readonly auth_mode?: 'service_bearer' | 'oauth' | 'api_token';
}

type AuthMode = 'service_bearer' | 'oauth' | 'api_token' | 'none';

function detectAuthMode(gw: InventoryGateway | null): {
  mode: AuthMode;
  oauth?: OAuthMeta;
  configFields?: ReadonlyArray<ConfigField>;
} {
  if (!gw) return { mode: 'none' };
  const schema = (gw.configSchema as ConfigSchemaMeta | undefined) ?? {};
  const configFields = schema.config_fields;
  if (schema.oauth) {
    return configFields
      ? { mode: 'oauth', oauth: schema.oauth, configFields }
      : { mode: 'oauth', oauth: schema.oauth };
  }
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
  const { mode, oauth, configFields } = detectAuthMode(gw);
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
    await renderOAuthFlow(card, api, serverName, cfg, oauth, configFields);
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
  configFields?: ReadonlyArray<ConfigField>,
): Promise<void> {
  const isDcr = oauth?.kind === 'dcr';
  const isSharedApp = oauth?.kind === 'shared-app';
  // Heuristik: gcloud (und vergleichbar) hat ein `_service_account_json`-Feld
  // in config_fields → SA-Key-Pfad als zweite Authentifizierungs-Option
  // verfuegbar. PWA zeigt das explicit als "OAuth ODER Service-Account".
  const hasSaPath =
    (configFields ?? []).some((f) => f.key === '_service_account_json');
  const refreshTokenField = cfg?.fields['_oauth_refresh_token'];

  const desc = document.createElement('p');
  desc.className = 'muted small';
  if (isDcr) {
    desc.textContent =
      'Dynamic Client Registration (DCR, RFC 7591): beim Klick auf Authorize ' +
      'registrieren wir einen eigenen OAuth-Client beim Provider. Du musst nichts eintragen. ' +
      'Refresh-Token wird KMS-encrypted gespeichert.';
  } else if (isSharedApp && hasSaPath) {
    desc.textContent =
      'Zwei Authentifizierungs-Pfade verfuegbar. WAEHLE EINEN:\n\n' +
      '  A) Service-Account (empfohlen fuer Headless/Production): SA-JSON unten paste, ' +
      'optional Projekt-Id ueberschreiben. Kein OAuth-Roundtrip noetig — Service-Account ' +
      'wird via JWT-Bearer-Grant lokal in access_token getauscht. Private-Key verlaesst approval2 nicht.\n\n' +
      '  B) User-OAuth: Client-ID + Secret deiner OAuth-App eintragen, dann Authorize. ' +
      'Aktionen laufen unter deinem Google-Account. Refresh-Token wird KMS-encrypted gespeichert.';
    desc.style.whiteSpace = 'pre-line';
  } else if (isSharedApp) {
    desc.textContent =
      'Shared-App OAuth: Client-ID + Secret deiner Google-OAuth-App eintragen, dann Authorize. ' +
      'Refresh-Token wird KMS-encrypted gespeichert. Du nutzt deine eigene OAuth-App — keine Doppler-Konfiguration noetig.';
  } else {
    desc.textContent =
      'Pre-registered OAuth 2.0: trage Client-ID + Client-Secret deiner OAuth-App ein, ' +
      'dann starte den Authorize-Flow. Refresh-Token wird KMS-encrypted gespeichert.';
  }
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

  // config_fields: server-deklarierte per-User-Felder (z.B. _service_account_json,
  // _gcp_project_id fuer gcloud). Andere Felder die nicht OAuth-spezifisch sind
  // rendern wir oberhalb der OAuth-Form. _oauth_*-Felder werden vom OAuth-Form
  // selbst verwaltet — die NICHT hier rendern (sonst doppelt).
  const OAUTH_KEYS = new Set([
    '_oauth_client_id',
    '_oauth_client_secret',
    '_oauth_refresh_token',
    '_oauth_access_token',
    '_oauth_access_token_expires_at',
  ]);
  const nonOauthFields = (configFields ?? []).filter((f) => !OAUTH_KEYS.has(f.key));
  if (nonOauthFields.length > 0) {
    if (hasSaPath) {
      const h3 = document.createElement('h3');
      h3.textContent = 'Pfad A: Service-Account';
      h3.style.marginTop = '1rem';
      card.appendChild(h3);
    }
    renderConfigFieldsForm(card, api, serverName, cfg, nonOauthFields);
    if (hasSaPath) {
      const h3 = document.createElement('h3');
      h3.textContent = 'Pfad B: User-OAuth';
      h3.style.marginTop = '1.5rem';
      card.appendChild(h3);
      const hint = document.createElement('p');
      hint.className = 'muted small';
      hint.textContent =
        'Wenn du oben den Service-Account-Pfad benutzt, kannst du diesen Bereich ueberspringen.';
      card.appendChild(hint);
    }
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

/**
 * Rendert server-deklarierte per-User-config_fields (z.B. SA-JSON, project_id).
 * Pro Feld ein Input/Textarea/Password mit Save-Button. Werte werden via
 * api.setServerConfig persistiert (KMS-encrypted wenn key mit `_` startet).
 */
function renderConfigFieldsForm(
  card: HTMLElement,
  api: ApiClient,
  serverName: string,
  cfg: { fields: Record<string, { value: string; isSecret: boolean }> } | null,
  fields: ReadonlyArray<ConfigField>,
): void {
  for (const f of fields) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.style.marginBottom = '0.75rem';
    const lbl = document.createElement('label');
    lbl.textContent = f.label;
    wrap.appendChild(lbl);
    const existing = cfg?.fields[f.key];
    const isSecret = f.is_secret === true || f.type === 'password';
    let inputEl: HTMLInputElement | HTMLTextAreaElement;
    if (f.type === 'textarea') {
      const ta = document.createElement('textarea');
      ta.rows = 6;
      ta.placeholder = existing
        ? (isSecret ? '••••••• (gesetzt — neuer Wert ersetzt)' : '(gesetzt — neuer Wert ersetzt)')
        : 'Hier paste …';
      inputEl = ta;
    } else {
      const i = document.createElement('input');
      i.type = isSecret ? 'password' : 'text';
      i.autocomplete = isSecret ? 'new-password' : 'off';
      i.placeholder = existing
        ? (isSecret ? '••••••• (gesetzt — neuer Wert ersetzt)' : '(gesetzt — neuer Wert ersetzt)')
        : '';
      inputEl = i;
    }
    wrap.appendChild(inputEl);
    if (f.description) {
      const help = document.createElement('p');
      help.className = 'muted small';
      help.style.marginTop = '0.25rem';
      help.textContent = f.description;
      wrap.appendChild(help);
    }
    const row = document.createElement('div');
    row.className = 'row form-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-secondary btn-small';
    saveBtn.textContent = existing ? 'Aktualisieren' : 'Speichern';
    const status = document.createElement('span');
    status.className = 'muted small';
    row.appendChild(saveBtn);
    row.appendChild(status);
    if (existing) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-secondary btn-small btn-danger';
      delBtn.textContent = 'Löschen';
      delBtn.addEventListener('click', async () => {
        if (!window.confirm(`Feld ${f.label} entfernen?`)) return;
        try {
          await api.deleteServerConfig(serverName, f.key);
          status.textContent = '✓ Geloescht — Page neu laden.';
          status.className = 'ok small';
        } catch (err) {
          status.textContent = `Fehler: ${(err as Error).message}`;
          status.className = 'err small';
        }
      });
      row.appendChild(delBtn);
    }
    wrap.appendChild(row);
    saveBtn.addEventListener('click', async () => {
      if (!inputEl.value) {
        status.textContent = 'Bitte Wert eingeben.';
        status.className = 'err small';
        return;
      }
      saveBtn.disabled = true;
      status.textContent = 'Speichere…';
      status.className = 'muted small';
      try {
        await api.setServerConfig(serverName, f.key, inputEl.value);
        status.textContent = '✓ Gespeichert';
        status.className = 'ok small';
        inputEl.value = '';
        inputEl.placeholder = isSecret ? '••••••• (gesetzt — neuer Wert ersetzt)' : '(gesetzt — neuer Wert ersetzt)';
      } catch (err) {
        status.textContent = `Fehler: ${(err as Error).message}`;
        status.className = 'err small';
      } finally {
        saveBtn.disabled = false;
      }
    });
    card.appendChild(wrap);
  }
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
    'Tool-Call eingefüllt, sofern der Caller keinen eigenen Wert übergibt. ' +
    'Profile erlauben mehrere Default-Sätze (z.B. prod / test) — der Tool-Call ' +
    'nutzt das aktive Profil; mit __profile als Arg kann per-Call überschrieben werden.';
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

  // Profile + Defaults + Hints parallel laden.
  let profiles: ReadonlyArray<import('./api.js').ToolDefaultProfile> = [];
  let allDefaults: ReadonlyArray<import('./api.js').ToolDefault> = [];
  let allHints: ReadonlyArray<import('./api.js').ToolDefaultHint> = [];
  try {
    [profiles, allDefaults, allHints] = await Promise.all([
      api.listProfiles(serverName),
      api.listToolDefaults(serverName),
      api.listHints(serverName).catch(() => []),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      renderSessionExpired(document.getElementById('app') ?? document.body);
      return;
    }
    // 404 = nichts gespeichert; weiter mit leerem State.
  }

  // Map: toolName -> fieldName -> hintText (Phase E).
  const hintsByTool = new Map<string, Map<string, string>>();
  for (const h of allHints) {
    if (!hintsByTool.has(h.toolName)) hintsByTool.set(h.toolName, new Map());
    hintsByTool.get(h.toolName)!.set(h.fieldName, h.hintText);
  }

  // Aktives Profil bestimmen — fallback 'default' wenn keines existiert.
  const activeProfile = profiles.find((p) => p.isActive)?.profileName ?? 'default';

  // Profile-Switcher-Bar (Phase C).
  const switcher = renderProfileSwitcher(api, serverName, profiles, activeProfile, body);
  card.appendChild(switcher);

  // Map: toolName -> ToolDefault[] (NUR active profile gefiltert).
  const byTool = new Map<string, import('./api.js').ToolDefault[]>();
  for (const e of allDefaults) {
    if (e.profileName !== activeProfile) continue;
    const arr = byTool.get(e.toolName) ?? [];
    arr.push(e);
    byTool.set(e.toolName, arr);
  }

  const toolsHost = document.createElement('div');
  toolsHost.className = 'tool-defaults-list';

  for (const tool of gw.tools) {
    const block = renderToolDefaultsBlock(
      api,
      serverName,
      activeProfile,
      tool.name,
      tool.description ?? '',
      (tool.inputSchema ?? null) as Record<string, unknown> | null,
      byTool.get(tool.name) ?? [],
      hintsByTool.get(tool.name) ?? new Map(),
    );
    toolsHost.appendChild(block);
  }

  card.appendChild(toolsHost);
  body.appendChild(card);
}

function renderProfileSwitcher(
  api: ApiClient,
  serverName: string,
  profiles: ReadonlyArray<import('./api.js').ToolDefaultProfile>,
  activeProfile: string,
  detailRoot: HTMLElement,
): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'tool-defaults-profile-bar';

  const label = document.createElement('span');
  label.className = 'muted small';
  label.textContent = 'Profil:';
  bar.appendChild(label);

  // Wenn keine Profile in der DB sind (frischer User), zeigen wir
  // 'default' als implizites Profil-Pill.
  const visibleProfiles = profiles.length > 0
    ? profiles
    : ([{ profileName: 'default', isActive: true } as import('./api.js').ToolDefaultProfile]);

  for (const p of visibleProfiles) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'pill tool-defaults-profile-pill';
    if (p.profileName === activeProfile) pill.classList.add('pill-ok', 'is-active');
    pill.textContent = (p.profileName === activeProfile ? '● ' : '○ ') + p.profileName;
    pill.title = p.description || `Profil "${p.profileName}"`;
    pill.addEventListener('click', async () => {
      if (p.profileName === activeProfile) return;
      pill.disabled = true;
      try {
        await api.activateProfile(serverName, p.profileName);
        showToast(`Profil "${p.profileName}" aktiviert.`, 'success');
        await refreshDefaultsTab(api, serverName, detailRoot);
      } catch (err) {
        pill.disabled = false;
        showToast(`Fehler: ${(err as Error).message}`, 'error');
      }
    });
    bar.appendChild(pill);

    // Delete-Button nur fuer nicht-aktive + nicht-'default'.
    if (p.profileName !== activeProfile && p.profileName !== 'default' && profiles.length > 0) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-secondary btn-small btn-danger';
      del.textContent = '×';
      del.title = `Profil "${p.profileName}" entfernen`;
      del.addEventListener('click', async () => {
        if (!window.confirm(`Profil "${p.profileName}" + alle Defaults darin entfernen?`))
          return;
        try {
          await api.deleteProfile(serverName, p.profileName);
          showToast('Profil entfernt.', 'success');
          await refreshDefaultsTab(api, serverName, detailRoot);
        } catch (err) {
          showToast(`Fehler: ${(err as Error).message}`, 'error');
        }
      });
      bar.appendChild(del);
    }
  }

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn-secondary btn-small';
  addBtn.textContent = '+ Profil';
  addBtn.addEventListener('click', () =>
    openNewProfileModal(api, serverName, profiles, detailRoot),
  );
  bar.appendChild(addBtn);

  return bar;
}

function openNewProfileModal(
  api: ApiClient,
  serverName: string,
  existingProfiles: ReadonlyArray<import('./api.js').ToolDefaultProfile>,
  detailRoot: HTMLElement,
): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal card';

  const h = document.createElement('h3');
  h.textContent = 'Neues Profil';
  modal.appendChild(h);

  const form = document.createElement('form');
  form.className = 'col';

  function mkField(labelText: string, input: HTMLElement, hint?: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const lbl = document.createElement('label');
    lbl.textContent = labelText;
    wrap.appendChild(lbl);
    wrap.appendChild(input);
    if (hint) {
      const h2 = document.createElement('div');
      h2.className = 'muted small';
      h2.textContent = hint;
      wrap.appendChild(h2);
    }
    return wrap;
  }

  const nameIn = document.createElement('input');
  nameIn.type = 'text';
  nameIn.required = true;
  nameIn.pattern = '[a-z][a-z0-9_-]{0,63}';
  nameIn.placeholder = 'z.B. test';
  form.appendChild(mkField('Name (Slug)', nameIn, 'Kleinbuchstaben, Ziffern, _ und -'));

  const descIn = document.createElement('input');
  descIn.type = 'text';
  descIn.placeholder = 'z.B. Lokale Postgres';
  descIn.maxLength = 256;
  form.appendChild(mkField('Beschreibung (optional)', descIn));

  const copySelect = document.createElement('select');
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '— leer anlegen —';
  copySelect.appendChild(noneOpt);
  for (const p of existingProfiles) {
    const opt = document.createElement('option');
    opt.value = p.profileName;
    opt.textContent = p.profileName;
    copySelect.appendChild(opt);
  }
  form.appendChild(
    mkField(
      'Kopieren aus',
      copySelect,
      'Optional: bestehendes Profil als Vorlage. Defaults werden mitkopiert.',
    ),
  );

  const activateLbl = document.createElement('label');
  activateLbl.className = 'row';
  const activateIn = document.createElement('input');
  activateIn.type = 'checkbox';
  activateLbl.appendChild(activateIn);
  const activateTxt = document.createElement('span');
  activateTxt.textContent = ' Direkt aktivieren';
  activateLbl.appendChild(activateTxt);
  form.appendChild(activateLbl);

  const actions = document.createElement('div');
  actions.className = 'row form-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-secondary';
  cancel.textContent = 'Abbrechen';
  cancel.addEventListener('click', () => overlay.remove());
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn';
  submit.textContent = 'Anlegen';
  actions.appendChild(cancel);
  actions.appendChild(submit);
  form.appendChild(actions);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    submit.disabled = true;
    try {
      await api.createProfile({
        serverName,
        name: nameIn.value.trim(),
        ...(descIn.value.trim() ? { description: descIn.value.trim() } : {}),
        ...(copySelect.value ? { copyFrom: copySelect.value } : {}),
        ...(activateIn.checked ? { activate: true } : {}),
      });
      showToast(`Profil "${nameIn.value.trim()}" angelegt.`, 'success');
      overlay.remove();
      await refreshDefaultsTab(api, serverName, detailRoot);
    } catch (err) {
      submit.disabled = false;
      showToast(`Fehler: ${(err as Error).message}`, 'error');
    }
  });

  modal.appendChild(form);
  overlay.appendChild(modal);
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
  nameIn.focus();
}

async function refreshDefaultsTab(
  api: ApiClient,
  serverName: string,
  detailRoot: HTMLElement,
): Promise<void> {
  // Triggern via custom-event — Server-Detail-Renderer hoert mit und
  // re-rendert. Wird in renderServerDetail() (am Top) registriert.
  detailRoot.dispatchEvent(
    new CustomEvent('tool-defaults:refresh', { bubbles: true, detail: { serverName } }),
  );
  // Fallback fuer den ersten Render-Pfad (kein Listener registriert):
  // wir machen einen page-reload-equivalent durch hash-Bounce.
  void api;
}

function renderToolDefaultsBlock(
  api: ApiClient,
  serverName: string,
  activeProfile: string,
  toolName: string,
  toolDesc: string,
  toolSchema: Record<string, unknown> | null,
  existing: ReadonlyArray<import('./api.js').ToolDefault>,
  hints: ReadonlyMap<string, string>,
): HTMLElement {
  const wrap = document.createElement('details');
  wrap.className = 'tool-defaults-tool card-section';
  if (existing.length > 0) wrap.open = true;

  const summary = document.createElement('summary');
  summary.className = 'tool-defaults-tool-head';
  const nameEl = document.createElement('span');
  nameEl.className = 'tool-name';
  nameEl.textContent = toolName;
  summary.appendChild(nameEl);
  if (existing.length > 0) {
    const pill = document.createElement('span');
    pill.className = 'pill pill-ok';
    pill.textContent = `${existing.length} default${existing.length === 1 ? '' : 's'}`;
    summary.appendChild(pill);
  }
  wrap.appendChild(summary);

  if (toolDesc) {
    const desc = document.createElement('p');
    desc.className = 'muted small';
    desc.textContent = toolDesc;
    wrap.appendChild(desc);
  }

  // Existing defaults rendern (typed, mit orphan-Badge wenn relevant).
  const list = document.createElement('div');
  list.className = 'tool-defaults-fields';
  const schemaFields = extractFieldsFromSchema(toolSchema);
  const schemaFieldMap = new Map(schemaFields.map((f) => [f.name, f]));
  const usedFieldNames = new Set<string>();
  for (const def of existing) {
    list.appendChild(
      renderDefaultRowTyped(
        api,
        serverName,
        toolName,
        def,
        schemaFieldMap.get(def.fieldName) ?? null,
        hints.get(def.fieldName) ?? null,
      ),
    );
    usedFieldNames.add(def.fieldName);
  }
  wrap.appendChild(list);

  // Phase E: Hints fuer Felder OHNE Default (User kann Hint setzen bevor er
  // einen Default speichert — z.B. um Doku zu hinterlegen).
  const fieldsWithHintOnly = [...hints.keys()].filter(
    (f) => !usedFieldNames.has(f),
  );
  if (fieldsWithHintOnly.length > 0) {
    const subhead = document.createElement('p');
    subhead.className = 'muted small';
    subhead.textContent = 'Hinweise (ohne aktiven Default):';
    wrap.appendChild(subhead);
    for (const fieldName of fieldsWithHintOnly) {
      list.appendChild(
        renderHintOnlyRow(api, serverName, toolName, fieldName, hints.get(fieldName) ?? ''),
      );
    }
  }

  // Field-Picker statt freier text-input
  if (schemaFields.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'muted small';
    hint.textContent =
      'Kein inputSchema verfuegbar — Defaults sind nicht typsicher setzbar fuer dieses Tool.';
    wrap.appendChild(hint);
    return wrap;
  }

  const addForm = document.createElement('form');
  addForm.className = 'tool-defaults-add-form col';

  const remaining = schemaFields.filter((f) => !usedFieldNames.has(f.name));
  if (remaining.length === 0) {
    const done = document.createElement('p');
    done.className = 'muted small';
    done.textContent = 'Alle Schema-Felder haben bereits Defaults.';
    wrap.appendChild(done);
    return wrap;
  }

  // Field-Selector
  const fieldRow = document.createElement('div');
  fieldRow.className = 'row tool-defaults-add-field';
  const fieldLbl = document.createElement('label');
  fieldLbl.textContent = 'Parameter wählen: ';
  fieldRow.appendChild(fieldLbl);
  const fieldSelect = document.createElement('select');
  fieldSelect.className = 'tool-defaults-field-select';
  for (const f of remaining) {
    const opt = document.createElement('option');
    opt.value = f.name;
    opt.textContent = `${f.name}${f.required ? ' *' : ''}`;
    fieldSelect.appendChild(opt);
  }
  fieldRow.appendChild(fieldSelect);
  addForm.appendChild(fieldRow);

  // Widget-Container (re-rendert sich beim Field-Wechsel)
  const widgetHost = document.createElement('div');
  widgetHost.className = 'tool-defaults-add-widget';
  addForm.appendChild(widgetHost);

  // Submit-Reihe
  const submitRow = document.createElement('div');
  submitRow.className = 'row tool-defaults-add-submit';
  const addBtn = document.createElement('button');
  addBtn.type = 'submit';
  addBtn.className = 'btn btn-secondary btn-small';
  addBtn.textContent = '+ Default speichern';
  submitRow.appendChild(addBtn);
  const status = document.createElement('span');
  status.className = 'muted small';
  submitRow.appendChild(status);
  addForm.appendChild(submitRow);

  let currentHandle: ReturnType<typeof renderWidget> | null = null;

  function rebuildWidget(): void {
    widgetHost.innerHTML = '';
    const fieldName = fieldSelect.value;
    const field = schemaFieldMap.get(fieldName);
    if (!field) return;
    const spec = pickWidget(field.schema);
    currentHandle = renderWidget(spec);
    widgetHost.appendChild(currentHandle.element);
    if (field.schema.description) {
      const d = document.createElement('div');
      d.className = 'muted small';
      d.textContent = String(field.schema.description);
      widgetHost.appendChild(d);
    }
    // Vorschlag-Default
    if (field.schema.default !== undefined) {
      try {
        currentHandle.setValue(field.schema.default);
      } catch {
        // ignore
      }
    }
  }
  fieldSelect.addEventListener('change', rebuildWidget);
  rebuildWidget();

  addForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!currentHandle) return;
    const fieldName = fieldSelect.value;
    const err = currentHandle.validate();
    if (err) {
      status.textContent = err;
      status.className = 'err small';
      return;
    }
    let value: unknown;
    try {
      value = currentHandle.getValue();
    } catch (e) {
      status.textContent = (e as Error).message;
      status.className = 'err small';
      return;
    }
    addBtn.disabled = true;
    status.textContent = '';
    try {
      await api.setToolDefault({
        serverName,
        toolName,
        fieldName,
        value,
        valueKind: currentHandle.valueKind,
        profile: activeProfile,
      });
      showToast(`Default ${fieldName} gespeichert.`, 'success');
      // Statt manuell DOM-Manipulation: ganze Tab neu rendern (einfacher + konsistent
      // mit Orphan-Banner-Logik).
      window.dispatchEvent(new CustomEvent('tool-defaults:refresh'));
    } catch (e) {
      status.textContent = `Fehler: ${(e as Error).message}`;
      status.className = 'err small';
    } finally {
      addBtn.disabled = false;
    }
  });

  wrap.appendChild(addForm);
  return wrap;
}

function renderDefaultRowTyped(
  api: ApiClient,
  serverName: string,
  toolName: string,
  def: import('./api.js').ToolDefault,
  field: import('./components/schema-form.js').SchemaField | null,
  currentHintText: string | null,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tool-defaults-row';
  row.dataset['field'] = def.fieldName;

  // Orphan-Marker (Plan §10 Entscheidung ⑤)
  if (def.orphanSince !== null) {
    row.classList.add('tool-defaults-row-orphan');
    const badge = document.createElement('span');
    badge.className = 'pill pill-warn';
    badge.textContent = 'orphan';
    badge.title =
      'Dieses Feld ist nicht (mehr) im Schema des Tools. Der Resolver ignoriert es. Entweder löschen oder Server-Tools neu entdecken.';
    row.appendChild(badge);
  }

  const lbl = document.createElement('label');
  lbl.className = 'tool-defaults-field-name';
  lbl.textContent = `${def.fieldName} `;
  const kindHint = document.createElement('span');
  kindHint.className = 'muted small';
  kindHint.textContent = `(${def.valueKind})`;
  lbl.appendChild(kindHint);
  row.appendChild(lbl);

  // Werte-Anzeige: einfaches read-only-Element. Edit-in-place via 🗑 + neu setzen.
  const valEl = document.createElement('code');
  valEl.className = 'tool-defaults-value';
  valEl.textContent = formatValue(def.value);
  row.appendChild(valEl);

  // Tools optional fuer Edit: bei Klick auf valEl Inline-Edit via passendem Widget.
  // Phase B minimal: nur Delete + Neu-Setzen via Field-Picker.
  // (Edit-in-place ist nice-to-have, kommt in Phase C zusammen mit Profile-Switch.)
  void field; // referenced for future inline edit
  void api;

  // Phase E: 💡-Hint-Button (Inline-Editor)
  const hintBtn = renderHintButton(api, serverName, toolName, def.fieldName, currentHintText);
  row.appendChild(hintBtn);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'btn btn-secondary btn-small btn-danger';
  delBtn.textContent = '×';
  delBtn.title = 'Default entfernen';
  delBtn.addEventListener('click', async () => {
    if (!window.confirm(`Default '${def.fieldName}' entfernen?`)) return;
    try {
      await api.deleteToolDefault({
        serverName,
        toolName,
        fieldName: def.fieldName,
        profile: def.profileName,
      });
      row.remove();
      showToast('Default entfernt.', 'success');
      window.dispatchEvent(new CustomEvent('tool-defaults:refresh'));
    } catch (err) {
      showToast(`Fehler: ${(err as Error).message}`, 'error');
    }
  });
  row.appendChild(delBtn);

  return row;
}

/**
 * Phase E: 💡-Icon-Button neben einem Field. Klick öffnet ein kleines
 * Inline-Modal mit `<textarea>` (max 500 chars). Empty-String = Hint löschen.
 */
function renderHintButton(
  api: ApiClient,
  serverName: string,
  toolName: string,
  fieldName: string,
  currentHintText: string | null,
): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-secondary btn-small tool-defaults-hint-btn';
  btn.textContent = currentHintText ? '💡' : '💭';
  btn.title = currentHintText ? `Hint: "${currentHintText}"` : 'Hint hinzufügen';
  btn.addEventListener('click', () =>
    openHintEditorModal(api, serverName, toolName, fieldName, currentHintText ?? ''),
  );
  return btn;
}

function openHintEditorModal(
  api: ApiClient,
  serverName: string,
  toolName: string,
  fieldName: string,
  currentHintText: string,
): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const modal = document.createElement('div');
  modal.className = 'modal card';

  const h = document.createElement('h3');
  h.textContent = `Hint: ${toolName} / ${fieldName}`;
  modal.appendChild(h);

  const desc = document.createElement('p');
  desc.className = 'muted small';
  desc.textContent =
    'Frei-Text-Beschreibung dieses Felds (≤500 chars). Wird beim LLM-Pfad ' +
    'als Hint mitgeliefert (`tools.help`) und optional beim Elicit-Hook gezeigt.';
  modal.appendChild(desc);

  const ta = document.createElement('textarea');
  ta.rows = 4;
  ta.maxLength = 500;
  ta.value = currentHintText;
  ta.placeholder = 'z.B. "0.0 deterministisch .. 2.0 wild"';
  ta.style.width = '100%';
  modal.appendChild(ta);

  const counter = document.createElement('div');
  counter.className = 'muted small';
  counter.textContent = `${ta.value.length} / 500`;
  ta.addEventListener('input', () => {
    counter.textContent = `${ta.value.length} / 500`;
  });
  modal.appendChild(counter);

  const actions = document.createElement('div');
  actions.className = 'row form-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-secondary';
  cancel.textContent = 'Abbrechen';
  cancel.addEventListener('click', () => overlay.remove());
  actions.appendChild(cancel);

  if (currentHintText) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-secondary btn-danger';
    del.textContent = 'Löschen';
    del.addEventListener('click', async () => {
      try {
        await api.deleteHint({ serverName, toolName, fieldName });
        showToast('Hint entfernt.', 'success');
        overlay.remove();
        window.dispatchEvent(new CustomEvent('tool-defaults:refresh'));
      } catch (err) {
        showToast(`Fehler: ${(err as Error).message}`, 'error');
      }
    });
    actions.appendChild(del);
  }

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn';
  save.textContent = 'Speichern';
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await api.setHint({
        serverName,
        toolName,
        fieldName,
        hintText: ta.value,
      });
      showToast('Hint gespeichert.', 'success');
      overlay.remove();
      window.dispatchEvent(new CustomEvent('tool-defaults:refresh'));
    } catch (err) {
      save.disabled = false;
      showToast(`Fehler: ${(err as Error).message}`, 'error');
    }
  });
  actions.appendChild(save);
  modal.appendChild(actions);

  overlay.appendChild(modal);
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
  ta.focus();
}

/**
 * Phase E: Hint-only-Row. Wird gezeigt für Felder die einen Hint haben, aber
 * keinen Default — z.B. "Felder die ich dokumentieren wollte aber noch nicht
 * benutze".
 */
function renderHintOnlyRow(
  api: ApiClient,
  serverName: string,
  toolName: string,
  fieldName: string,
  hintText: string,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tool-defaults-row tool-defaults-row-hint-only';
  row.dataset['field'] = fieldName;

  const lbl = document.createElement('label');
  lbl.className = 'tool-defaults-field-name muted';
  lbl.textContent = fieldName;
  row.appendChild(lbl);

  const hintEl = document.createElement('span');
  hintEl.className = 'tool-defaults-hint-text muted small';
  hintEl.textContent = `💡 "${hintText}"`;
  row.appendChild(hintEl);

  row.appendChild(renderHintButton(api, serverName, toolName, fieldName, hintText));
  return row;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
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

  // Phase C: Profile-Switcher + Profile-CRUD + Set/Delete-Defaults
  // dispatchen 'tool-defaults:refresh' nach Aenderungen.
  const refreshListener = (): void => {
    void onChanged();
  };
  // Register on root + bubble-fenster damit Modal-Overlay-Sources auch
  // erreicht werden.
  root.addEventListener('tool-defaults:refresh', refreshListener);
  window.addEventListener('tool-defaults:refresh', refreshListener);

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
