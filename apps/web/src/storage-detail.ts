/**
 * Storage-Detail-View — Object-Read + Delete + Force-Toggle + Edit-Pencil.
 *
 * Hash-Route: `#/storage/<id>`
 *
 * UX:
 *   - Header mit Back-Button + Title
 *   - Meta (subtype, size, visibility, created)
 *   - Summary-Section mit Edit-Pencil (nur subtype=doc, opens Modal)
 *   - Body-Preview (decoded falls utf8, sonst <hex preview>)
 *   - Footer: Force-Delete-Checkbox (refcount>0) + Delete-Button
 *
 * Delete-Flow: PATCH/DELETE → Backend antwortet mit approvalId, PWA navigiert
 * zu #/approvals damit der User signed.
 */
import type { ApiStorageClient, KnowledgeObject } from './api-storage.js';
import type { ApiClient, Session } from './api.js';
import { logout } from './auth.js';
import { renderHeader } from './components/header.js';

function formatBytes(n: number | undefined): string {
  if (n === undefined || n === null) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function decodeBody(obj: KnowledgeObject): string {
  if (!obj.body) return '';
  const encoding = obj.bodyEncoding ?? 'utf8';
  if (encoding === 'utf8') return obj.body;
  if (encoding === 'base64') {
    try {
      const decoded = atob(obj.body);
      // If it looks like text, render it; otherwise show hex preview
      if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(decoded)) return decoded;
      // Hex preview of first 256 bytes
      let hex = '';
      for (let i = 0; i < Math.min(decoded.length, 256); i++) {
        hex += decoded.charCodeAt(i).toString(16).padStart(2, '0') + ' ';
      }
      return `<binary, ${decoded.length} bytes>\n${hex}${decoded.length > 256 ? '…' : ''}`;
    } catch {
      return '<unable to decode base64 body>';
    }
  }
  return obj.body;
}

function showToast(msg: string): void {
  const t = document.createElement('div');
  t.className = 'storage-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

export async function renderStorageDetail(
  root: HTMLElement,
  api: ApiStorageClient,
  authApi: ApiClient,
  session: Session,
  objectId: string,
): Promise<void> {
  root.innerHTML = '';
  renderHeader(root, session, () => void logout(authApi));

  const main = document.createElement('main');
  main.className = 'storage-detail';
  root.appendChild(main);

  main.innerHTML = '<p class="muted">Loading…</p>';

  let obj: KnowledgeObject;
  try {
    obj = await api.getObject(objectId, { expandBody: true });
  } catch (err) {
    main.innerHTML = '';
    const errEl = document.createElement('p');
    errEl.className = 'err';
    errEl.textContent = `Fehler: ${(err as Error).message}`;
    main.appendChild(errEl);

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn btn-secondary';
    back.textContent = '← Zurück';
    back.addEventListener('click', () => {
      window.location.hash = '#/storage';
    });
    main.appendChild(back);
    return;
  }

  main.innerHTML = '';

  // Header
  const header = document.createElement('header');
  header.className = 'storage-detail-head';

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'btn btn-secondary back-btn';
  back.textContent = '← Back';
  back.addEventListener('click', () => {
    window.location.hash = '#/storage';
  });
  header.appendChild(back);

  const title = document.createElement('h1');
  title.textContent = obj.title ?? obj.filename ?? obj.id;
  header.appendChild(title);

  main.appendChild(header);

  // Meta
  const metaSection = document.createElement('section');
  metaSection.className = 'storage-meta card';
  const dl = document.createElement('dl');
  const metaPairs: ReadonlyArray<[string, string]> = [
    ['Subtype', obj.subtype ?? '-'],
    ['Size', formatBytes(obj.bodySize)],
    ['Visibility', obj.visibility ?? 'private'],
    ['Refcount', String(obj.refcount ?? 0)],
    ['Created', obj.createdAt ? new Date(obj.createdAt).toLocaleString() : '-'],
    ['Updated', obj.updatedAt ? new Date(obj.updatedAt).toLocaleString() : '-'],
    ['ID', obj.id],
  ];
  for (const [k, v] of metaPairs) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  metaSection.appendChild(dl);
  main.appendChild(metaSection);

  // Summary (with Edit-Pencil)
  if (obj.description !== undefined && obj.description !== null) {
    const summary = document.createElement('section');
    summary.className = 'storage-summary card';

    const sh = document.createElement('h2');
    sh.textContent = 'Summary';
    if (obj.subtype === 'doc') {
      const pencil = document.createElement('button');
      pencil.type = 'button';
      pencil.className = 'edit-pencil';
      pencil.textContent = '✏️';
      pencil.title = 'Summary bearbeiten';
      pencil.addEventListener('click', () => {
        openSummaryModal(api, obj);
      });
      sh.appendChild(pencil);
    }
    summary.appendChild(sh);

    const p = document.createElement('p');
    p.textContent = obj.description || '(leer)';
    summary.appendChild(p);

    main.appendChild(summary);
  }

  // Body
  const bodySection = document.createElement('section');
  bodySection.className = 'storage-body card';
  const bh = document.createElement('h2');
  bh.textContent = 'Body';
  bodySection.appendChild(bh);

  const pre = document.createElement('pre');
  pre.className = 'storage-body-pre';
  pre.textContent = decodeBody(obj) || '(empty)';
  bodySection.appendChild(pre);
  main.appendChild(bodySection);

  // Actions footer
  const footer = document.createElement('footer');
  footer.className = 'storage-actions card';

  let forceCheckbox: HTMLInputElement | null = null;
  if ((obj.refcount ?? 0) > 0) {
    const wrap = document.createElement('label');
    wrap.className = 'force-delete-label';
    forceCheckbox = document.createElement('input');
    forceCheckbox.type = 'checkbox';
    forceCheckbox.id = 'force-delete';
    wrap.appendChild(forceCheckbox);
    const span = document.createElement('span');
    span.textContent = ` Force delete (refcount=${obj.refcount})`;
    wrap.appendChild(span);
    footer.appendChild(wrap);
  }

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'btn btn-danger delete-btn';
  delBtn.textContent = '🗑 Delete';
  delBtn.addEventListener('click', () => {
    void handleDelete(api, obj, forceCheckbox, delBtn);
  });
  footer.appendChild(delBtn);

  main.appendChild(footer);
}

async function handleDelete(
  api: ApiStorageClient,
  obj: KnowledgeObject,
  forceCheckbox: HTMLInputElement | null,
  btn: HTMLButtonElement,
): Promise<void> {
  const force = forceCheckbox?.checked ?? false;
  const label = obj.title ?? obj.filename ?? obj.id;
  if (!window.confirm(`Delete "${label}"?\n\nEin Approval-Request wird erstellt; du musst ihn in der Approval-Queue signen.`)) {
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    await api.deleteObject(obj.id, { force });
    showToast('Approval-Request erstellt. Check Approval-Queue.');
    window.location.hash = '#/approvals';
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '🗑 Delete';
    window.alert(`Delete failed: ${(err as Error).message}`);
  }
}

function openSummaryModal(api: ApiStorageClient, obj: KnowledgeObject): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'storage-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'storage-modal card';

  const h = document.createElement('h2');
  h.textContent = 'Summary bearbeiten';
  modal.appendChild(h);

  const hint = document.createElement('p');
  hint.className = 'muted small';
  hint.textContent = '120–1500 Zeichen. Wird via Vectorize neu embedded.';
  modal.appendChild(hint);

  const textarea = document.createElement('textarea');
  textarea.value = obj.description ?? '';
  textarea.rows = 8;
  textarea.className = 'storage-summary-textarea';
  modal.appendChild(textarea);

  const counter = document.createElement('div');
  counter.className = 'muted small';
  const updateCounter = (): void => {
    const len = textarea.value.length;
    counter.textContent = `${len} chars`;
    counter.classList.toggle('err', len > 0 && (len < 120 || len > 1500));
  };
  textarea.addEventListener('input', updateCounter);
  updateCounter();
  modal.appendChild(counter);

  const actions = document.createElement('div');
  actions.className = 'row form-actions';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-secondary';
  cancel.textContent = 'Abbrechen';
  cancel.addEventListener('click', () => backdrop.remove());
  actions.appendChild(cancel);

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn';
  save.textContent = 'Speichern (Approval)';
  save.addEventListener('click', () => {
    void (async () => {
      const summary = textarea.value.trim();
      if (summary.length < 120 || summary.length > 1500) {
        window.alert('Summary muss 120–1500 Zeichen lang sein.');
        return;
      }
      save.disabled = true;
      save.textContent = 'Sending…';
      try {
        await api.updateSummary(obj.id, summary);
        backdrop.remove();
        showToast('Approval-Request erstellt. Check Approval-Queue.');
        window.location.hash = '#/approvals';
      } catch (err) {
        save.disabled = false;
        save.textContent = 'Speichern (Approval)';
        window.alert(`Update failed: ${(err as Error).message}`);
      }
    })();
  });
  actions.appendChild(save);

  modal.appendChild(actions);
  backdrop.appendChild(modal);
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) backdrop.remove();
  });
  document.body.appendChild(backdrop);
  textarea.focus();
}
