/**
 * Tool-Defaults-Tab — Browser + Edit-Form fuer gespeicherte Tool-Defaults.
 *
 * Plan-Ref: docs/plans/done/PLAN-prefs.md (Burst 7 PWA-Surface).
 *
 * UX:
 *   - Liste der eigenen Defaults, gruppiert by `toolName`.
 *   - Pro Eintrag: `field`, `value` (als JSON), `scope` (badge), Remove-Button.
 *   - Add-Form unten: toolName / field / value (JSON-Validated) / scope-Select.
 *
 * Server-Surface: `/v1/prefs` (cookie-authed, same-origin) — siehe api-prefs.ts.
 *
 * Edit-Strategie: Defaults werden NICHT in-place editiert, sondern via "Replace":
 *   User klickt Remove → fuegt neuen Wert ueber Add-Form hinzu.
 * Inline-Edit ist eine Folge-Iteration (analog zur alten defaults-tab.js
 * JSON-Edit-Surface), aber out-of-scope fuer Burst 7-Minimum.
 */
import type { ApiPrefsClient, PrefScope, ToolDefault } from './api-prefs.js';
import { ApiError } from './api.js';
import { logout, renderSessionExpired } from './auth.js';
import type { ApiClient, Session } from './api.js';
import { renderHeader } from './components/header.js';
import { renderEmptyState } from './components/empty-state.js';
import { showToast } from './components/toast.js';

const VALID_SCOPES: ReadonlyArray<PrefScope> = ['user', 'session', 'tenant'];

export async function renderDefaultsTab(
  root: HTMLElement,
  api: ApiClient,
  apiPrefs: ApiPrefsClient,
  session: Session,
): Promise<void> {
  root.innerHTML = '';
  renderHeader(root, session, () => void logout(api));

  const main = document.createElement('main');
  main.className = 'defaults-tab';

  const h1 = document.createElement('h1');
  h1.textContent = 'Tool defaults';
  main.appendChild(h1);

  const explainer = document.createElement('section');
  explainer.className = 'card defaults-explainer';
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent =
    'Wenn du haeufig Werte in Tool-Calls wiederholst (z.B. immer denselben Channel), speichere sie hier als Default. Sie werden automatisch eingesetzt und du kannst sie per Tool-Call ueberschreiben.';
  explainer.appendChild(p);
  main.appendChild(explainer);

  const listSection = document.createElement('section');
  listSection.className = 'list-section';

  const listTitle = document.createElement('h2');
  listTitle.textContent = 'Stored defaults';
  listSection.appendChild(listTitle);

  const list = document.createElement('div');
  list.className = 'list';
  list.id = 'defaults-list';
  listSection.appendChild(list);

  main.appendChild(listSection);

  main.appendChild(renderAddForm(apiPrefs));

  root.appendChild(main);

  await refreshList(apiPrefs);
}

async function refreshList(apiPrefs: ApiPrefsClient): Promise<void> {
  const list = document.getElementById('defaults-list');
  if (!list) return;
  list.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const defaults = await apiPrefs.listPrefs();
    list.innerHTML = '';
    if (defaults.length === 0) {
      list.appendChild(
        renderEmptyState({
          title: 'No defaults yet',
          body: 'Add your first tool-default using the form below.',
        }),
      );
      return;
    }
    const grouped = groupByTool(defaults);
    for (const [toolName, items] of grouped) {
      list.appendChild(renderToolGroup(toolName, items, apiPrefs));
    }
  } catch (err) {
    list.innerHTML = '';
    const errEl = document.createElement('p');
    errEl.className = 'err';
    if (err instanceof ApiError && err.status === 401) {
      renderSessionExpired(document.getElementById('app') ?? document.body);
      return;
    }
    if (err instanceof ApiError && err.status === 404) {
      errEl.textContent =
        'Backend route /v1/prefs not deployed yet — defaults werden derzeit nur ueber MCP-Tools (prefs.get/set) erreichbar.';
    } else {
      errEl.textContent = `Failed to load defaults: ${(err as Error).message}`;
    }
    list.appendChild(errEl);
  }
}

function groupByTool(defaults: ReadonlyArray<ToolDefault>): Map<string, ToolDefault[]> {
  const map = new Map<string, ToolDefault[]>();
  for (const d of defaults) {
    const arr = map.get(d.toolName) ?? [];
    arr.push(d);
    map.set(d.toolName, arr);
  }
  // Stable sort by toolName for deterministic UI
  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function renderToolGroup(
  toolName: string,
  items: ReadonlyArray<ToolDefault>,
  apiPrefs: ApiPrefsClient,
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'card defaults-group';
  section.dataset['tool'] = toolName;

  const head = document.createElement('div');
  head.className = 'row defaults-group-head';
  const h3 = document.createElement('h3');
  const codeEl = document.createElement('code');
  codeEl.textContent = toolName;
  h3.appendChild(codeEl);
  head.appendChild(h3);
  section.appendChild(head);

  const ul = document.createElement('ul');
  ul.className = 'defaults-list';
  for (const item of items) {
    ul.appendChild(renderDefaultRow(item, apiPrefs));
  }
  section.appendChild(ul);

  return section;
}

function renderDefaultRow(item: ToolDefault, apiPrefs: ApiPrefsClient): HTMLElement {
  const li = document.createElement('li');
  li.className = 'defaults-row';

  const fieldSpan = document.createElement('strong');
  fieldSpan.className = 'defaults-field';
  fieldSpan.textContent = item.field;
  li.appendChild(fieldSpan);

  const eq = document.createElement('span');
  eq.className = 'muted small';
  eq.textContent = ' = ';
  li.appendChild(eq);

  const valueCode = document.createElement('code');
  valueCode.className = 'defaults-value';
  valueCode.textContent = formatValue(item.value);
  li.appendChild(valueCode);

  const scope = document.createElement('span');
  scope.className = `pill defaults-scope defaults-scope-${item.scope}`;
  scope.textContent = item.scope;
  li.appendChild(scope);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn btn-secondary btn-small btn-danger defaults-remove';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => {
    void handleRemove(item, apiPrefs, removeBtn, li);
  });
  li.appendChild(removeBtn);

  return li;
}

async function handleRemove(
  item: ToolDefault,
  apiPrefs: ApiPrefsClient,
  btn: HTMLButtonElement,
  row: HTMLElement,
): Promise<void> {
  if (!window.confirm(`Remove default ${item.toolName}.${item.field} (scope=${item.scope})?`)) {
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Removing…';
  try {
    await apiPrefs.removePref({ toolName: item.toolName, field: item.field, scope: item.scope });
    row.remove();
    showToast(`Removed ${item.toolName}.${item.field}`, 'success');
    // Wenn die Tool-Gruppe leer ist, refresh damit der Group-Header verschwindet.
    const list = document.getElementById('defaults-list');
    if (list) {
      const empty = list.querySelectorAll('.defaults-group').length;
      if (empty === 0) await refreshList(apiPrefs);
    }
  } catch (err) {
    btn.textContent = 'Remove';
    btn.disabled = false;
    showToast(`Remove failed: ${(err as Error).message}`, 'error');
  }
}

function formatValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function renderAddForm(apiPrefs: ApiPrefsClient): HTMLElement {
  const section = document.createElement('section');
  section.className = 'card add-form-section defaults-add';

  const title = document.createElement('h2');
  title.textContent = 'Add default';
  section.appendChild(title);

  const form = document.createElement('form');
  form.id = 'add-default-form';
  form.className = 'form';

  const toolField = makeField('toolName', 'Tool name');
  const toolInput = document.createElement('input');
  toolInput.name = 'toolName';
  toolInput.type = 'text';
  toolInput.placeholder = 'e.g. slack.send';
  toolInput.required = true;
  toolInput.maxLength = 128;
  toolField.appendChild(toolInput);
  form.appendChild(toolField);

  const fieldField = makeField('field', 'Field');
  const fieldInput = document.createElement('input');
  fieldInput.name = 'field';
  fieldInput.type = 'text';
  fieldInput.placeholder = 'e.g. channel';
  fieldInput.required = true;
  fieldInput.maxLength = 128;
  fieldField.appendChild(fieldInput);
  form.appendChild(fieldField);

  const valueField = makeField('value', 'Value (JSON)');
  const valueInput = document.createElement('textarea');
  valueInput.name = 'value';
  valueInput.rows = 3;
  valueInput.placeholder = '"#general"   or   true   or   { "foo": 1 }';
  valueInput.required = true;
  valueInput.spellcheck = false;
  valueField.appendChild(valueInput);
  const valueHint = document.createElement('span');
  valueHint.className = 'muted small';
  valueHint.textContent =
    'Strings als JSON-String mit Anfuehrungszeichen ("hello"). Numbers / booleans / objects ohne.';
  valueField.appendChild(valueHint);
  form.appendChild(valueField);

  const scopeField = makeField('scope', 'Scope');
  const scopeSelect = document.createElement('select');
  scopeSelect.name = 'scope';
  for (const s of VALID_SCOPES) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s === 'user' ? 'user (default)' : s;
    if (s === 'user') opt.selected = true;
    scopeSelect.appendChild(opt);
  }
  scopeField.appendChild(scopeSelect);
  form.appendChild(scopeField);

  const submitRow = document.createElement('div');
  submitRow.className = 'row form-actions';

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn';
  submitBtn.textContent = 'Save';
  submitRow.appendChild(submitBtn);

  const status = document.createElement('span');
  status.className = 'muted small form-status';
  submitRow.appendChild(status);

  form.appendChild(submitRow);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const toolName = toolInput.value.trim();
    const field = fieldInput.value.trim();
    const valueRaw = valueInput.value.trim();
    const scope = scopeSelect.value as PrefScope;

    if (!toolName || !field || !valueRaw) {
      status.textContent = 'All fields required.';
      status.className = 'err small form-status';
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(valueRaw);
    } catch (e) {
      status.textContent = `Invalid JSON: ${(e as Error).message}`;
      status.className = 'err small form-status';
      return;
    }

    submitBtn.disabled = true;
    status.textContent = 'Saving…';
    status.className = 'muted small form-status';
    try {
      await apiPrefs.setPref({ toolName, field, value, scope });
      status.textContent = 'Saved.';
      status.className = 'ok small form-status';
      showToast(`Saved default ${toolName}.${field}`, 'success');
      fieldInput.value = '';
      valueInput.value = '';
      submitBtn.disabled = false;
      await refreshList(apiPrefs);
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
