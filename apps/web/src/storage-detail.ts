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
import { dispatchRenderer } from './renderers/index.js';

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

/**
 * IPI-Wrapper-Tags aus migrierten v1-Items strippen.
 *
 * v1's MCP-Server wrapped tool-outputs mit
 *   `<external-content source="kc:..." untrusted="true">...</external-content>`
 * als instruction-injection-Schutz fuer LLM-Kontext. Bei der v1→v2-Migration
 * landeten diese Wrapper im persisted body/description-String drin. Im PWA-
 * Display sind sie nicht hilfreich. Defensive Strip mit Regex.
 */
function stripIpiWrappers(s: string): string {
  if (!s) return s;
  return s
    .replace(/<external-content\s+source="[^"]*"\s+untrusted="[^"]*">/g, '')
    .replace(/<\/external-content>/g, '');
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

  // ─── Header: Back-Link + Title + Action-Row ────────────────────────
  const header = document.createElement('header');
  header.className = 'storage-detail-head';

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'btn btn-secondary btn-small back-btn';
  back.textContent = '← Back';
  back.addEventListener('click', () => {
    window.location.hash = '#/storage';
  });
  header.appendChild(back);

  const title = document.createElement('h1');
  title.textContent = obj.title ?? obj.filename ?? obj.id;
  header.appendChild(title);

  // Action-Buttons rechts (Info-Toggle + Copy-ID + Delete).
  const actions = document.createElement('div');
  actions.className = 'storage-detail-actions';

  const infoBtn = document.createElement('button');
  infoBtn.type = 'button';
  infoBtn.className = 'icon-btn storage-info-toggle';
  infoBtn.setAttribute('aria-label', 'Meta-Infos anzeigen');
  infoBtn.setAttribute('title', 'Meta-Infos');
  infoBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
  actions.appendChild(infoBtn);

  // Copy-ID-Button: kopiert eine Agent-lesbare Referenz auf das Object.
  // Format ist eine kompakte mehrzeilige Notation die der Agent direkt
  // verstehen kann (id + subtype + title), nicht nur die nackte UUID.
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'icon-btn storage-copy-btn';
  copyBtn.setAttribute('aria-label', 'ID + Titel kopieren (fuer Agent-Referenz)');
  copyBtn.setAttribute('title', 'ID kopieren');
  copyBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  copyBtn.addEventListener('click', async () => {
    const ref = `Storage-Object:
  id:      ${obj.id}
  subtype: ${obj.subtype ?? '-'}
  title:   ${obj.title ?? obj.filename ?? '-'}`;
    try {
      await navigator.clipboard.writeText(ref);
      showToast('ID + Titel kopiert');
    } catch {
      showToast('Kopieren fehlgeschlagen');
    }
  });
  actions.appendChild(copyBtn);

  let forceCheckbox: HTMLInputElement | null = null;
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'icon-btn storage-delete-btn';
  delBtn.setAttribute('aria-label', `Object loeschen`);
  delBtn.setAttribute('title', 'Object loeschen');
  delBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>`;
  delBtn.addEventListener('click', () => {
    void handleDelete(api, obj, forceCheckbox, delBtn);
  });
  actions.appendChild(delBtn);

  header.appendChild(actions);
  main.appendChild(header);

  // ─── Force-Delete Toggle (nur wenn refcount > 0) ────────────────────
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
    main.appendChild(wrap);
  }

  // ─── Meta-Section (hidden by default, Toggle via Info-Button) ───────
  const metaSection = document.createElement('section');
  metaSection.className = 'storage-meta card';
  metaSection.hidden = true;
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

  infoBtn.addEventListener('click', () => {
    metaSection.hidden = !metaSection.hidden;
    infoBtn.classList.toggle('active', !metaSection.hidden);
  });

  // ─── Summary + Body — beide default OPEN (User-Wunsch).
  // Kein Accordion-Sync mehr: User soll beide gleichzeitig lesen koennen.
  if (obj.description !== undefined && obj.description !== null && obj.description !== '') {
    const summaryDetails = document.createElement('details');
    summaryDetails.className = 'storage-summary card';
    summaryDetails.open = true;
    const s = document.createElement('summary');
    s.textContent = 'Summary';
    if (obj.subtype === 'doc') {
      const pencil = document.createElement('button');
      pencil.type = 'button';
      pencil.className = 'edit-pencil';
      pencil.textContent = '✏️';
      pencil.title = 'Summary bearbeiten';
      pencil.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openSummaryModal(api, obj);
      });
      s.appendChild(pencil);
    }
    summaryDetails.appendChild(s);
    const p = document.createElement('p');
    p.className = 'storage-summary-text';
    p.textContent = stripIpiWrappers(obj.description);
    summaryDetails.appendChild(p);
    main.appendChild(summaryDetails);
  }

  // Body — nur rendern wenn tatsaechlich Body-Content da ist.
  // body===null/undefined (= server hat kein body geliefert) → kein Section.
  // body==='' (= leerer body) → kein Section.
  const hasBody = obj.body !== undefined && obj.body !== null && obj.body !== '';
  if (hasBody) {
    const bodyDetails = document.createElement('details');
    bodyDetails.className = 'storage-body card';
    bodyDetails.open = true; // default open (User-Wunsch)
    const bs = document.createElement('summary');
    bs.textContent = 'Body';
    bodyDetails.appendChild(bs);

    const rendered = dispatchRenderer(obj);
    walkAndStripIpi(rendered);

    if (!rendered.textContent || rendered.textContent.trim().length === 0) {
      // Renderer leer → decoded raw als pre
      const raw = decodeBody(obj);
      if (raw) {
        const pre = document.createElement('pre');
        pre.className = 'storage-body-pre';
        pre.textContent = stripIpiWrappers(raw);
        bodyDetails.appendChild(pre);
      }
    } else {
      bodyDetails.appendChild(rendered);
    }
    main.appendChild(bodyDetails);
  }
}

/**
 * Walks ein DOM-Subtree und ersetzt jeden Text-Node-Inhalt mit dem
 * IPI-Wrapper-getrippten Pendant. Ueber den Renderer hinausgegangener
 * Defense-Layer fuer migrierte Items.
 */
function walkAndStripIpi(root: Node): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n: Node | null = walker.nextNode();
  while (n !== null) {
    if (n.textContent && /external-content/.test(n.textContent)) {
      n.textContent = stripIpiWrappers(n.textContent);
    }
    n = walker.nextNode();
  }
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
