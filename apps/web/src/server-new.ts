/**
 * Server-New-Form — #/tools/servers/new
 *
 * Plan-Ref: PLAN-per-user-server-store.md Phase 4 (User-Added-Server).
 *
 * Der User kann eigene Sub-MCP-Server zur Hub-Instance hinzufuegen. Diese
 * Server sind nur fuer ihn sichtbar (RLS auf sub_mcp_servers).
 *
 * Felder:
 *   - name           (URL-safe slug, lowercase, unique)
 *   - displayName    (im PWA-UI)
 *   - baseUrl        (https://-only)
 *   - authMode       service_bearer (default) | oauth
 *   - serviceToken   nur bei service_bearer — optional, kann auch spaeter
 *                    via config-Drawer/_oauth-Felder nachgepflegt werden
 *
 * Nach Anlage: Auto-Subscription aktiviert, redirect zu #/tools/servers.
 */
import type { ApiClient, Session } from './api.js';
import { ApiError } from './api.js';
import { logout, renderSessionExpired } from './auth.js';
import { renderHeader } from './components/header.js';

export async function renderServerNew(
  root: HTMLElement,
  api: ApiClient,
  session: Session,
): Promise<void> {
  root.replaceChildren();
  renderHeader(root, session, () => void logout(api));

  const main = document.createElement('main');
  main.className = 'tools-tab server-new';

  const h1 = document.createElement('h1');
  h1.textContent = 'MCP-Server hinzufügen';
  main.appendChild(h1);

  const desc = document.createElement('p');
  desc.className = 'muted';
  desc.textContent =
    'Eigenen MCP-Server zur Hub-Instance verkabeln. Nur du siehst diesen Server. ' +
    'Tokens und OAuth-Credentials werden nach Anlage im Konfigurieren-Drawer hinterlegt.';
  main.appendChild(desc);

  const form = document.createElement('form');
  form.className = 'form card';

  // name
  const nameWrap = field('name', 'Name (slug, lowercase, eindeutig)');
  const nameInput = document.createElement('input');
  nameInput.name = 'name';
  nameInput.type = 'text';
  nameInput.required = true;
  nameInput.placeholder = 'meinserver';
  nameInput.pattern = '[a-z][a-z0-9_-]*';
  nameInput.maxLength = 64;
  nameWrap.appendChild(nameInput);
  form.appendChild(nameWrap);

  // displayName
  const dispWrap = field('displayName', 'Anzeigename');
  const dispInput = document.createElement('input');
  dispInput.name = 'displayName';
  dispInput.type = 'text';
  dispInput.required = true;
  dispInput.placeholder = 'Mein MCP-Server';
  dispInput.maxLength = 128;
  dispWrap.appendChild(dispInput);
  form.appendChild(dispWrap);

  // baseUrl
  const urlWrap = field('baseUrl', 'Base-URL (https://…)');
  const urlInput = document.createElement('input');
  urlInput.name = 'baseUrl';
  urlInput.type = 'url';
  urlInput.required = true;
  urlInput.placeholder = 'https://mcp.example.com';
  urlInput.pattern = 'https://.*';
  urlWrap.appendChild(urlInput);
  form.appendChild(urlWrap);

  // authMode
  const modeWrap = field('authMode', 'Auth-Modus');
  const modeSelect = document.createElement('select');
  modeSelect.name = 'authMode';
  const optBearer = document.createElement('option');
  optBearer.value = 'service_bearer';
  optBearer.textContent = 'service_bearer (Shared-Token)';
  modeSelect.appendChild(optBearer);
  const optOAuth = document.createElement('option');
  optOAuth.value = 'oauth';
  optOAuth.textContent = 'oauth (pre-registered Client)';
  modeSelect.appendChild(optOAuth);
  modeWrap.appendChild(modeSelect);
  form.appendChild(modeWrap);

  // serviceTokenPlain (nur bei service_bearer sichtbar)
  const tokenWrap = field('serviceTokenPlain', 'Service-Token (optional, kann auch später ergänzt werden)');
  const tokenInput = document.createElement('input');
  tokenInput.name = 'serviceTokenPlain';
  tokenInput.type = 'password';
  tokenInput.placeholder = 'Worker-Shared-Token';
  tokenInput.autocomplete = 'off';
  tokenInput.maxLength = 512;
  tokenWrap.appendChild(tokenInput);
  form.appendChild(tokenWrap);

  // Phase F UX-Refactor: OAuth-Felder (nur bei authMode=oauth sichtbar).
  // Diese werden als configSchema._meta.oauth persistiert, damit der Auth-Tab
  // sie spaeter findet — fuer Server die kein _meta in tools/list deklarieren
  // (z.B. GitHub-MCP, Drittpartei).
  const oauthBlock = document.createElement('div');
  oauthBlock.className = 'oauth-fields-block';
  oauthBlock.style.display = 'none';

  const oauthHelp = document.createElement('p');
  oauthHelp.className = 'muted small';
  oauthHelp.textContent =
    'Pre-registered OAuth 2.0 — du musst eine OAuth-App beim Provider anlegen (z.B. github.com/settings/applications/new). ' +
    'Trage hier die URLs aus der Provider-Docs ein. Client-ID + Client-Secret folgen nach dem Anlegen unter "Auth".';
  oauthBlock.appendChild(oauthHelp);

  const authzWrap = field('oauth_authorize_url', 'OAuth Authorize-URL');
  const authzInput = document.createElement('input');
  authzInput.type = 'url';
  authzInput.placeholder = 'https://github.com/login/oauth/authorize';
  authzWrap.appendChild(authzInput);
  oauthBlock.appendChild(authzWrap);

  const tokenUrlWrap = field('oauth_token_url', 'OAuth Token-URL');
  const tokenUrlInput = document.createElement('input');
  tokenUrlInput.type = 'url';
  tokenUrlInput.placeholder = 'https://github.com/login/oauth/access_token';
  tokenUrlWrap.appendChild(tokenUrlInput);
  oauthBlock.appendChild(tokenUrlWrap);

  const scopesWrap = field('oauth_scopes', 'OAuth Scopes (komma-getrennt)');
  const scopesInput = document.createElement('input');
  scopesInput.type = 'text';
  scopesInput.placeholder = 'repo,user';
  scopesWrap.appendChild(scopesInput);
  oauthBlock.appendChild(scopesWrap);

  const providerWrap = field('oauth_provider', 'OAuth-Provider-Name (display)');
  const providerInput = document.createElement('input');
  providerInput.type = 'text';
  providerInput.placeholder = 'github';
  providerWrap.appendChild(providerInput);
  oauthBlock.appendChild(providerWrap);

  form.appendChild(oauthBlock);

  modeSelect.addEventListener('change', () => {
    tokenWrap.style.display = modeSelect.value === 'service_bearer' ? '' : 'none';
    oauthBlock.style.display = modeSelect.value === 'oauth' ? '' : 'none';
  });

  // submit + cancel
  const actions = document.createElement('div');
  actions.className = 'row form-actions';
  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn btn-primary';
  submitBtn.textContent = 'Server anlegen';
  actions.appendChild(submitBtn);
  const cancelBtn = document.createElement('a');
  cancelBtn.href = '#/tools/servers';
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Abbrechen';
  actions.appendChild(cancelBtn);
  const status = document.createElement('span');
  status.className = 'muted small form-status';
  actions.appendChild(status);
  form.appendChild(actions);

  main.appendChild(form);
  root.appendChild(main);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    submitBtn.disabled = true;
    status.textContent = 'Lege Server an…';
    status.className = 'muted small form-status';
    try {
      // OAuth-configSchema bauen wenn authMode=oauth + URLs gefuellt
      let configSchema: Record<string, unknown> | undefined;
      if (modeSelect.value === 'oauth' && (authzInput.value || tokenUrlInput.value)) {
        const scopes = scopesInput.value
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        configSchema = {
          oauth: {
            provider: providerInput.value.trim() || 'custom',
            kind: 'pre',
            ...(authzInput.value ? { authorize_url: authzInput.value.trim() } : {}),
            ...(tokenUrlInput.value ? { token_url: tokenUrlInput.value.trim() } : {}),
            ...(scopes.length > 0 ? { scopes } : {}),
          },
        };
      }

      const args = {
        name: nameInput.value.trim().toLowerCase(),
        displayName: dispInput.value.trim(),
        baseUrl: urlInput.value.trim(),
        authMode: modeSelect.value as 'service_bearer' | 'oauth',
        enableSubscription: true,
        ...(tokenInput.value && modeSelect.value === 'service_bearer'
          ? { serviceTokenPlain: tokenInput.value }
          : {}),
        ...(configSchema ? { configSchema } : {}),
      };
      await api.addUserServer(args);
      status.textContent = `${args.name} angelegt. Weiterleitung…`;
      status.className = 'ok small form-status';
      window.setTimeout(() => {
        // Phase B/C: nach Anlage direkt in den Auth-Tab fuer Token/OAuth-Setup
        window.location.hash = `#/tools/servers/${encodeURIComponent(args.name)}/auth`;
      }, 700);
    } catch (err) {
      submitBtn.disabled = false;
      if (err instanceof ApiError && err.status === 401) {
        renderSessionExpired(root);
        return;
      }
      const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
      status.textContent = `Fehler: ${msg}`;
      status.className = 'err small form-status';
    }
  });
}

function field(name: string, label: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const lbl = document.createElement('label');
  lbl.htmlFor = name;
  lbl.textContent = label;
  wrap.appendChild(lbl);
  return wrap;
}
