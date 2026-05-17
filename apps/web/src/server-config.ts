/**
 * Server-Config-Drawer — Per-Server-Config-Page fuer #/tools/servers/:name/config.
 *
 * Plan-Ref: docs/plans/active/PLAN-per-user-server-store.md (Phase 2).
 *
 * Rendert dynamisch aus `gateway.configSchema._meta.config_fields[]` ein
 * Form-Set. Werte werden via PUT /v1/me/servers/:name/config/:key gespeichert
 * (KMS-encrypted server-side). Secret-Felder (key startet mit `_`) als
 * password-input + masked-display.
 *
 * Subscription-Toggle + (in Phase 3) OAuth-Authorize-Button leben auch hier.
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

interface ConfigField {
  readonly key: string;
  readonly label: string;
  readonly type: 'text' | 'select' | 'password';
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly options?: ReadonlyArray<string>;
}

interface ConfigSchemaMeta {
  readonly config_fields?: ReadonlyArray<ConfigField>;
  readonly oauth?: {
    readonly provider?: string;
    readonly kind?: 'pre' | 'dcr';
    readonly scopes?: ReadonlyArray<string>;
    readonly help_url?: string;
  };
}

interface ConfigGetResponse {
  readonly fields: Record<string, { value: string; isSecret: boolean; updatedAt: number }>;
}

function parseSchema(gw: InventoryGateway | undefined): ConfigSchemaMeta {
  if (!gw?.configSchema) return {};
  return gw.configSchema as ConfigSchemaMeta;
}

function renderField(
  field: ConfigField,
  currentValue: string | undefined,
  isFieldSet: boolean,
): { row: HTMLElement; input: HTMLInputElement | HTMLSelectElement; meta: ConfigField } {
  const wrap = document.createElement('div');
  wrap.className = 'field';

  const label = document.createElement('label');
  label.htmlFor = `cfg-${field.key}`;
  label.textContent = field.label + (field.required ? ' *' : '');
  wrap.appendChild(label);

  let input: HTMLInputElement | HTMLSelectElement;
  if (field.type === 'select' && field.options) {
    const sel = document.createElement('select');
    sel.id = `cfg-${field.key}`;
    sel.name = field.key;
    if (!field.required) {
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = '— nicht gesetzt —';
      sel.appendChild(blank);
    }
    for (const opt of field.options) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      sel.appendChild(o);
    }
    if (currentValue !== undefined && !isFieldSet) sel.value = currentValue;
    input = sel;
  } else {
    const inp = document.createElement('input');
    inp.id = `cfg-${field.key}`;
    inp.name = field.key;
    inp.type = field.type === 'password' ? 'password' : 'text';
    inp.autocomplete = field.type === 'password' ? 'new-password' : 'off';
    if (field.placeholder) inp.placeholder = field.placeholder;
    // Secret-Felder bleiben leer, zeigen nur "***" als Platzhalter wenn gesetzt
    if (field.type === 'password' && isFieldSet) {
      inp.placeholder = '••••••• (gesetzt — neuer Wert ueberschreibt)';
    } else if (currentValue !== undefined) {
      inp.value = currentValue;
    }
    input = inp;
  }
  wrap.appendChild(input);

  return { row: wrap, input, meta: field };
}

export async function renderServerConfig(
  root: HTMLElement,
  api: ApiClient,
  session: Session,
  serverName: string,
): Promise<void> {
  root.replaceChildren();
  renderHeader(root, session, () => void logout(api));

  const main = document.createElement('main');
  main.className = 'server-config';

  const backLink = document.createElement('a');
  backLink.href = '#/tools/servers';
  backLink.className = 'muted small';
  backLink.textContent = '← Zurück zu Tools & Servers';
  main.appendChild(backLink);

  const h1 = document.createElement('h1');
  h1.textContent = serverName;
  main.appendChild(h1);

  const status = document.createElement('p');
  status.className = 'muted';
  status.textContent = 'Lade Server-Details…';
  main.appendChild(status);

  root.appendChild(main);

  // 1. Inventar laden um Server-Metadata + configSchema zu finden
  let inv: InventoryResponse;
  let cfgValues: ConfigGetResponse | null = null;
  try {
    [inv, cfgValues] = await Promise.all([
      api.listInventory(),
      api.getServerConfig(serverName).catch((err) => {
        // 404 = noch keine Configs gespeichert; nicht-404 weiterwerfen
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      renderSessionExpired(root);
      return;
    }
    const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
    status.className = 'err';
    status.textContent = `Fehler: ${msg}`;
    return;
  }

  const gw = inv.gateways.find((g) => g.name === serverName);
  if (!gw) {
    status.className = 'err';
    status.textContent = `Server '${serverName}' nicht gefunden oder nicht aktiviert.`;
    return;
  }

  // Replace status with content
  main.removeChild(status);
  // Update h1 with display name
  h1.textContent = gw.displayName || gw.name;

  // --- Section: Subscription
  const subSection = document.createElement('section');
  subSection.className = 'card';
  const subTitle = document.createElement('h2');
  subTitle.textContent = 'Subscription';
  subSection.appendChild(subTitle);
  const subDesc = document.createElement('p');
  subDesc.className = 'muted small';
  subDesc.textContent = 'Aktiviert: dieser Server liefert Tools in deinem MCP-Client.';
  subSection.appendChild(subDesc);
  const deactivateBtn = document.createElement('button');
  deactivateBtn.type = 'button';
  deactivateBtn.className = 'btn btn-secondary btn-small';
  deactivateBtn.textContent = serverName === 'knowledge2' ? 'Embedded — nicht deaktivierbar' : 'Deaktivieren';
  if (serverName === 'knowledge2') deactivateBtn.disabled = true;
  deactivateBtn.addEventListener('click', async () => {
    if (!window.confirm(`${gw.displayName} deaktivieren? Tools verschwinden aus deiner Liste.`)) return;
    try {
      await api.setServerSubscription(serverName, false);
      showToast(`${serverName} deaktiviert.`, 'success');
      window.location.hash = '#/tools/servers';
    } catch (err) {
      showToast(`Fehler: ${(err as Error).message}`, 'error');
    }
  });
  subSection.appendChild(deactivateBtn);
  main.appendChild(subSection);

  // --- Section: Config-Fields (aus configSchema)
  const schema = parseSchema(gw);
  const cfgSection = document.createElement('section');
  cfgSection.className = 'card';
  const cfgTitle = document.createElement('h2');
  cfgTitle.textContent = 'Konfiguration';
  cfgSection.appendChild(cfgTitle);

  if (schema.oauth?.help_url) {
    const help = document.createElement('p');
    help.className = 'muted small';
    help.textContent = `OAuth-Setup: ${schema.oauth.help_url}`;
    cfgSection.appendChild(help);
  }

  const fields = schema.config_fields ?? [];
  if (fields.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent =
      'Dieser Server deklariert keine Config-Felder. Falls Authentifizierung ' +
      'noetig ist, hinterlege Tokens unter Credentials.';
    cfgSection.appendChild(empty);
  } else {
    const form = document.createElement('form');
    form.className = 'form';

    const fieldRows: Array<{
      input: HTMLInputElement | HTMLSelectElement;
      meta: ConfigField;
      hadValue: boolean;
    }> = [];
    for (const f of fields) {
      const currentRec = cfgValues?.fields[f.key];
      const currentValue = currentRec
        ? currentRec.isSecret
          ? undefined // secrets nicht vor-fuellen
          : currentRec.value
        : undefined;
      const { row, input, meta } = renderField(f, currentValue, !!currentRec && currentRec.isSecret);
      form.appendChild(row);
      fieldRows.push({ input, meta, hadValue: !!currentRec });
    }

    const formStatus = document.createElement('span');
    formStatus.className = 'muted small form-status';
    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'btn btn-primary';
    submitBtn.textContent = 'Speichern';
    const submitRow = document.createElement('div');
    submitRow.className = 'row form-actions';
    submitRow.appendChild(submitBtn);
    submitRow.appendChild(formStatus);
    form.appendChild(submitRow);

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      submitBtn.disabled = true;
      formStatus.className = 'muted small form-status';
      formStatus.textContent = 'Speichere…';
      try {
        for (const fr of fieldRows) {
          const val = fr.input.value;
          // Empty-Input = keine Aenderung (besonders bei Secrets wo wir keinen
          // Wert vor-fuellen). Wenn das Feld gesetzt war und User nichts
          // eingibt, ueberspringen wir.
          if (val === '' && fr.hadValue && fr.meta.type === 'password') continue;
          if (val === '' && !fr.meta.required) {
            // optional-Feld geleert → delete
            if (fr.hadValue) {
              await api.deleteServerConfig(serverName, fr.meta.key);
            }
            continue;
          }
          if (val === '' && fr.meta.required) {
            throw new Error(`Feld '${fr.meta.label}' ist Pflicht.`);
          }
          await api.setServerConfig(serverName, fr.meta.key, val);
        }
        formStatus.className = 'ok small form-status';
        formStatus.textContent = 'Gespeichert.';
        submitBtn.disabled = false;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          renderSessionExpired(root);
          return;
        }
        formStatus.className = 'err small form-status';
        formStatus.textContent = (err as Error).message;
        submitBtn.disabled = false;
      }
    });
    cfgSection.appendChild(form);
  }

  main.appendChild(cfgSection);

  // --- Section: OAuth (Phase 3)
  if (schema.oauth) {
    const oauthSection = document.createElement('section');
    oauthSection.className = 'card';
    const oauthTitle = document.createElement('h2');
    oauthTitle.textContent = 'OAuth-Authorisierung';
    oauthSection.appendChild(oauthTitle);

    const oauthDesc = document.createElement('p');
    oauthDesc.className = 'muted small';
    oauthDesc.textContent = `Provider: ${schema.oauth.provider ?? '—'} · Modus: ${schema.oauth.kind ?? 'pre'} · Scopes: ${(schema.oauth.scopes ?? []).join(', ') || '—'}`;
    oauthSection.appendChild(oauthDesc);

    // Status: refresh_token vorhanden?
    const hasToken = !!cfgValues?.fields['_oauth_refresh_token'];
    const statusRow = document.createElement('p');
    if (hasToken) {
      statusRow.className = 'ok small';
      statusRow.textContent = '✓ Authorisiert — Refresh-Token gespeichert (KMS-encrypted).';
    } else {
      statusRow.className = 'muted small';
      statusRow.textContent = '⚠ Noch nicht authorisiert. Trage zuerst _oauth_client_id (und ggf. _oauth_client_secret) oberhalb ein, dann starte den Authorize-Flow.';
    }
    oauthSection.appendChild(statusRow);

    const authorizeBtn = document.createElement('button');
    authorizeBtn.type = 'button';
    authorizeBtn.className = 'btn btn-primary btn-small';
    authorizeBtn.textContent = hasToken ? 'Re-Authorisieren' : 'OAuth starten';
    const authorizeStatus = document.createElement('span');
    authorizeStatus.className = 'muted small';
    authorizeStatus.style.marginLeft = '0.5rem';

    authorizeBtn.addEventListener('click', async () => {
      authorizeBtn.disabled = true;
      authorizeStatus.className = 'muted small';
      authorizeStatus.textContent = 'Starte OAuth…';
      try {
        // Server-side bridge `/oauth/sub-mcp-callback?name=<name>` 302-
        // redirected nach Code-Receipt zur Hash-Route hier in der PWA.
        // RFC 6749 §3.1.2 verbietet Fragments in redirect_uri — GitHub-
        // App und andere strict-Provider rejecten sonst beim authorize.
        const redirectUri = `${window.location.origin}/oauth/sub-mcp-callback?name=${encodeURIComponent(serverName)}`;
        const result = await api.startServerOAuth(serverName, redirectUri);
        // Pre-Save: SessionStorage damit der Callback-Route den state matchen kann
        sessionStorage.setItem(`oauth_state_${serverName}`, result.state);
        window.location.href = result.authorizeUrl;
      } catch (err) {
        authorizeBtn.disabled = false;
        if (err instanceof ApiError && err.status === 401) {
          renderSessionExpired(root);
          return;
        }
        authorizeStatus.className = 'err small';
        authorizeStatus.textContent = `Fehler: ${(err as Error).message}`;
      }
    });

    const oauthActions = document.createElement('div');
    oauthActions.className = 'row';
    oauthActions.style.marginTop = '0.5rem';
    oauthActions.appendChild(authorizeBtn);
    oauthActions.appendChild(authorizeStatus);
    oauthSection.appendChild(oauthActions);

    if (schema.oauth.help_url) {
      const helpRow = document.createElement('p');
      helpRow.className = 'muted small';
      helpRow.style.marginTop = '0.5rem';
      helpRow.textContent = `Setup-Hinweis: ${schema.oauth.help_url}`;
      oauthSection.appendChild(helpRow);
    }

    main.appendChild(oauthSection);
  }
}

/**
 * Callback-Page fuer OAuth-Redirect zurueck von Provider.
 * URL: #/tools/servers/<name>/oauth/callback?state=...&code=...
 */
export async function renderServerOAuthCallback(
  root: HTMLElement,
  api: ApiClient,
  session: Session,
  serverName: string,
): Promise<void> {
  root.replaceChildren();
  renderHeader(root, session, () => void logout(api));

  const main = document.createElement('main');
  main.className = 'server-config';

  const h1 = document.createElement('h1');
  h1.textContent = `OAuth-Callback: ${serverName}`;
  main.appendChild(h1);

  const status = document.createElement('p');
  status.className = 'muted';
  status.textContent = 'Verarbeite OAuth-Antwort…';
  main.appendChild(status);
  root.appendChild(main);

  // Parse state + code aus dem Hash-Query
  const hash = window.location.hash;
  const qIdx = hash.indexOf('?');
  if (qIdx < 0) {
    status.className = 'err';
    status.textContent = 'Fehler: keine Query-Parameter im Callback-URL.';
    return;
  }
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  const state = params.get('state');
  const code = params.get('code');
  const error = params.get('error');
  if (error) {
    status.className = 'err';
    status.textContent = `OAuth-Provider hat abgelehnt: ${error}`;
    return;
  }
  if (!state || !code) {
    status.className = 'err';
    status.textContent = 'Fehler: state oder code fehlt.';
    return;
  }
  const expectedState = sessionStorage.getItem(`oauth_state_${serverName}`);
  if (expectedState && expectedState !== state) {
    status.className = 'err';
    status.textContent = 'CSRF-Verdacht: state stimmt nicht mit dem gespeicherten Wert ueberein.';
    return;
  }

  try {
    await api.completeServerOAuth(serverName, state, code);
    sessionStorage.removeItem(`oauth_state_${serverName}`);
    status.className = 'ok';
    status.textContent = '✓ Authorisierung erfolgreich. Du wirst weitergeleitet…';
    setTimeout(() => {
      // Phase C UX-Refactor: redirect zur neuen Detail-Page Auth-Tab
      // (statt Legacy /config-Drawer).
      window.location.hash = `#/tools/servers/${encodeURIComponent(serverName)}/auth`;
    }, 1500);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      renderSessionExpired(root);
      return;
    }
    status.className = 'err';
    status.textContent = `Authorisierung fehlgeschlagen: ${(err as Error).message}`;
  }
}
