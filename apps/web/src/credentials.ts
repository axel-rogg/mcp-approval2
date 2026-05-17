/**
 * Credentials-Management-View.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5 (Credentials & Crypto).
 *
 * UX:
 *   - Liste aller eigener Credentials (provider/label/kind/createdAt)
 *   - Add-Form: provider / kind / label / secret → optional PRF-Sign → POST
 *   - Delete-Button pro Credential → confirm → DELETE
 *
 * PRF-Layer: jede neue Credential triggert WebAuthn-Sign mit PRF-Extension.
 * Der PRF-Output landet via /v1/credentials/prf-session als prfSessionId
 * im Server-side in-memory store (5 min TTL); der prfSessionId wird dann
 * als optionaler Body-Param an POST /v1/credentials geschickt.
 */
import type { ApiClient, CredentialKind, CredentialMeta, Session } from './api.js';
import { ApiError } from './api.js';
import { logout, renderSessionExpired } from './auth.js';
import { renderHeader } from './components/header.js';
import { renderEmptyState } from './components/empty-state.js';
import { evalPrf, bytesToB64 } from './webauthn-prf.js';

interface ProviderOption {
  readonly value: string;
  readonly label: string;
  readonly defaultKind: CredentialKind;
}

const PROVIDERS: ProviderOption[] = [
  { value: 'github', label: 'GitHub', defaultKind: 'api_token' },
  { value: 'gitlab', label: 'GitLab', defaultKind: 'api_token' },
  { value: 'jira', label: 'Jira / Confluence', defaultKind: 'api_token' },
  { value: 'google-workspace', label: 'Google Workspace', defaultKind: 'oauth_refresh' },
  { value: 'other', label: 'Other', defaultKind: 'api_token' },
];

const KINDS: CredentialKind[] = ['api_token', 'oauth_refresh', 'password', 'service_account'];

export async function renderCredentials(
  root: HTMLElement,
  api: ApiClient,
  session: Session,
): Promise<void> {
  root.innerHTML = '';
  renderHeader(root, session, () => void logout(api));

  const main = document.createElement('main');
  main.className = 'credentials';
  await renderCredentialsBody(main, api);
  root.appendChild(main);
}

/**
 * Rendert den Credentials-Inhalt (h1 + Desc + Add-Form + Liste) in einen
 * existierenden Container — ohne eigene Topbar. Wird von Settings-Tab als
 * Sub-Tab eingehaengt, kann aber auch eigenstaendig genutzt werden.
 */
export async function renderCredentialsBody(
  container: HTMLElement,
  api: ApiClient,
): Promise<void> {
  const h1 = document.createElement('h1');
  h1.textContent = 'MCP credentials';
  container.appendChild(h1);

  const desc = document.createElement('p');
  desc.className = 'muted';
  desc.textContent =
    'Zugangsdaten fuer MCP-Server (API-Tokens, OAuth-Refresh, Service-Accounts). ' +
    'Verschluesselt mit Vault-KEK + WebAuthn-PRF — nur du kannst entschluesseln.';
  container.appendChild(desc);

  container.appendChild(renderAddForm(api));

  const listSection = document.createElement('section');
  listSection.className = 'list-section';

  const listTitle = document.createElement('h2');
  listTitle.textContent = 'Gespeicherte Credentials';
  listSection.appendChild(listTitle);

  const list = document.createElement('div');
  list.className = 'list';
  list.id = 'credentials-list';
  listSection.appendChild(list);

  container.appendChild(listSection);

  await refreshList(api);
}

async function refreshList(api: ApiClient): Promise<void> {
  const list = document.getElementById('credentials-list');
  if (!list) return;
  list.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const items = await api.listCredentials();
    list.innerHTML = '';
    if (items.length === 0) {
      list.appendChild(
        renderEmptyState({
          title: 'No credentials yet',
          body: 'Add your first credential using the form above.',
        }),
      );
      return;
    }
    for (const item of items) {
      list.appendChild(renderCredentialRow(item, api));
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      renderSessionExpired(document.getElementById('app') ?? document.body);
      return;
    }
    list.innerHTML = '';
    const errEl = document.createElement('p');
    errEl.className = 'err';
    errEl.textContent = `Failed to load credentials: ${(err as Error).message}`;
    list.appendChild(errEl);
  }
}

function renderCredentialRow(item: CredentialMeta, api: ApiClient): HTMLElement {
  const row = document.createElement('div');
  row.className = 'card credential';
  row.dataset['id'] = item.id;

  const head = document.createElement('div');
  head.className = 'row credential-head';

  const title = document.createElement('strong');
  title.textContent = `${item.provider} / ${item.label}`;
  head.appendChild(title);

  const kind = document.createElement('span');
  kind.className = 'pill';
  kind.textContent = item.kind;
  head.appendChild(kind);

  if (item.prfEnabled) {
    const prfBadge = document.createElement('span');
    prfBadge.className = 'pill pill-ok';
    prfBadge.textContent = 'PRF';
    prfBadge.title = 'Encrypted with WebAuthn-PRF — requires passkey-tap to decrypt.';
    head.appendChild(prfBadge);
  }

  row.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'muted small';
  const created = new Date(item.createdAt).toLocaleString();
  meta.textContent = `Created ${created}${item.lastUsedAt ? ` · Last used ${new Date(item.lastUsedAt).toLocaleString()}` : ''}`;
  row.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'row credential-actions';

  const delBtn = document.createElement('button');
  delBtn.className = 'btn btn-secondary btn-danger';
  delBtn.type = 'button';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', () => {
    void handleDelete(item, api, row, delBtn);
  });
  actions.appendChild(delBtn);

  row.appendChild(actions);
  return row;
}

async function handleDelete(
  item: CredentialMeta,
  api: ApiClient,
  row: HTMLElement,
  btn: HTMLButtonElement,
): Promise<void> {
  if (!window.confirm(`Delete credential "${item.provider}/${item.label}"? This cannot be undone.`)) {
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    await api.deleteCredential(item.id);
    row.remove();
  } catch (err) {
    btn.textContent = 'Delete';
    btn.disabled = false;
    window.alert(`Delete failed: ${(err as Error).message}`);
  }
}

function renderAddForm(api: ApiClient): HTMLElement {
  const section = document.createElement('section');
  section.className = 'card add-form-section';

  const title = document.createElement('h2');
  title.textContent = 'Add credential';
  section.appendChild(title);

  const form = document.createElement('form');
  form.id = 'add-credential-form';
  form.className = 'form';

  // provider
  const providerField = makeField('provider', 'Provider');
  const providerSelect = document.createElement('select');
  providerSelect.name = 'provider';
  providerSelect.required = true;
  for (const p of PROVIDERS) {
    const opt = document.createElement('option');
    opt.value = p.value;
    opt.textContent = p.label;
    providerSelect.appendChild(opt);
  }
  providerField.appendChild(providerSelect);
  form.appendChild(providerField);

  // kind
  const kindField = makeField('kind', 'Kind');
  const kindSelect = document.createElement('select');
  kindSelect.name = 'kind';
  kindSelect.required = true;
  for (const k of KINDS) {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = k;
    kindSelect.appendChild(opt);
  }
  kindField.appendChild(kindSelect);
  form.appendChild(kindField);

  // label
  const labelField = makeField('label', 'Label');
  const labelInput = document.createElement('input');
  labelInput.name = 'label';
  labelInput.type = 'text';
  labelInput.placeholder = 'work / personal / oss';
  labelInput.required = true;
  labelInput.maxLength = 128;
  labelField.appendChild(labelInput);
  form.appendChild(labelField);

  // secret
  const secretField = makeField('secret', 'Secret');
  const secretInput = document.createElement('input');
  secretInput.name = 'secret';
  secretInput.type = 'password';
  secretInput.placeholder = 'API-Token / Password / Refresh-Token';
  secretInput.required = true;
  secretInput.autocomplete = 'off';
  secretField.appendChild(secretInput);
  form.appendChild(secretField);

  // submit
  const submitRow = document.createElement('div');
  submitRow.className = 'row form-actions';

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn';
  submitBtn.textContent = 'Add credential';
  submitRow.appendChild(submitBtn);

  const status = document.createElement('span');
  status.className = 'muted small form-status';
  submitRow.appendChild(status);

  form.appendChild(submitRow);

  // wire provider→kind defaults
  providerSelect.addEventListener('change', () => {
    const p = PROVIDERS.find((pp) => pp.value === providerSelect.value);
    if (p) kindSelect.value = p.defaultKind;
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const provider = providerSelect.value;
    const kind = kindSelect.value as CredentialKind;
    const label = labelInput.value.trim();
    const secret = secretInput.value;
    if (!provider || !kind || !label || !secret) {
      status.textContent = 'All fields required.';
      status.className = 'err small form-status';
      return;
    }
    submitBtn.disabled = true;
    status.textContent = 'Requesting passkey-PRF…';
    status.className = 'muted small form-status';
    try {
      // PRF-Sign mit provider/label als AAD-equivalentem Salt
      const salt = new TextEncoder().encode(`credentials:add:${provider}:${label}`);
      let prfSessionId: string | undefined;
      try {
        const prf = await evalPrf({ salt });
        const session = await api.storePrfSession({
          prfOutput: bytesToB64(prf.prfOutput),
        });
        prfSessionId = session.sessionId;
      } catch (prfErr) {
        // PRF nicht verfuegbar (kein Passkey, kein Support) — fortfahren ohne,
        // Server faellt auf Vault-only-Crypto zurueck wenn prf_enabled=false
        // erlaubt ist.
        const proceed = window.confirm(
          `PRF unavailable: ${(prfErr as Error).message}\n\nProceed without PRF? The credential will be Vault-only (less secure).`,
        );
        if (!proceed) {
          status.textContent = 'Cancelled.';
          status.className = 'muted small form-status';
          submitBtn.disabled = false;
          return;
        }
      }

      status.textContent = 'Saving…';
      await api.addCredential({
        provider,
        kind,
        label,
        secret,
        ...(prfSessionId ? { prfSessionId } : {}),
      });

      status.textContent = 'Added.';
      status.className = 'ok small form-status';
      labelInput.value = '';
      secretInput.value = '';
      submitBtn.disabled = false;
      await refreshList(api);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        renderSessionExpired(document.getElementById('app') ?? document.body);
        return;
      }
      status.textContent = `Failed: ${(err as Error).message}`;
      status.className = 'err small form-status';
      submitBtn.disabled = false;
    }
  });

  section.appendChild(form);
  return section;
}

function makeField(name: string, label: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const lbl = document.createElement('label');
  lbl.htmlFor = name;
  lbl.textContent = label;
  wrap.appendChild(lbl);
  return wrap;
}
