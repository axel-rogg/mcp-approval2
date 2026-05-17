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

  // --- Section: OAuth (Phase 3 placeholder)
  if (schema.oauth) {
    const oauthSection = document.createElement('section');
    oauthSection.className = 'card';
    const oauthTitle = document.createElement('h2');
    oauthTitle.textContent = 'OAuth';
    oauthSection.appendChild(oauthTitle);
    const oauthDesc = document.createElement('p');
    oauthDesc.className = 'muted small';
    oauthDesc.textContent = `Provider: ${schema.oauth.provider ?? '—'} · Modus: ${schema.oauth.kind ?? 'pre'} · Scopes: ${(schema.oauth.scopes ?? []).join(', ') || '—'}`;
    oauthSection.appendChild(oauthDesc);
    const oauthHint = document.createElement('p');
    oauthHint.className = 'muted small';
    oauthHint.textContent =
      'OAuth-Authorize-Flow folgt in Phase 3. Du kannst aktuell deinen ' +
      'OAuth-Refresh-Token manuell via "_oauth_refresh_token"-Config-Feld ' +
      'oberhalb eintragen (Setup-URL: siehe Hinweis oben).';
    oauthSection.appendChild(oauthHint);
    main.appendChild(oauthSection);
  }
}
