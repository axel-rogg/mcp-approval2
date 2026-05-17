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
import type { ApiStorageClient, KnowledgeObject, RefView } from './api-storage.js';
import type { ApiClient, Session } from './api.js';
import { logout } from './auth.js';
import { renderHeader } from './components/header.js';
import { dispatchRenderer } from './renderers/index.js';
import { decodeBody } from './renderers/utils.js';

function formatBytes(n: number | undefined): string {
  if (n === undefined || n === null) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
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

/** Force-reload current hash-route ohne Full-Page-Reload. */
function reloadCurrentView(): void {
  const cur = window.location.hash;
  // toggle via tmp hash dann zurueck — triggert hashchange-listener.
  window.location.hash = '#/__reload__';
  setTimeout(() => {
    window.location.hash = cur;
  }, 0);
}

/**
 * Ob der Body eines Objekts textuell editierbar ist.
 * Conservative — Apps haben eigene Pipeline, skill_manifest hat hidden
 * Frontmatter-State, list hat schon checkbox-ticks, binary/image kann
 * man im Browser nicht text-edit.
 */
function isBodyTextEditable(obj: KnowledgeObject): boolean {
  const subtype = obj.subtype ?? '';
  if (subtype.startsWith('app:')) return false;
  if (subtype === 'skill_manifest') return false;
  if (subtype === 'list') return false;
  if (subtype === 'note' || subtype === 'memo') return true;
  if (subtype === 'doc') {
    const mime = obj.mimeType ?? obj.contentType ?? '';
    if (mime.startsWith('image/')) return false;
    if (mime.startsWith('application/octet-stream')) return false;
    return true;
  }
  return true; // Default: editable für unknown subtypes
}

/**
 * Render compact refs section as collapsible `<details>` with chip-style
 * link buttons. Default-collapsed (User-Wunsch). Returns null when both
 * directions empty.
 *
 * PLAN-document-linking §10.5 D1 + D4. Direction-derived role labels:
 *   outgoing.resource   → "📎"   incoming.resource   → "↩ Teil von"
 *   outgoing.references → "↗"    incoming.references → "↩"
 *   outgoing.depends_on → "⚙"    incoming.depends_on → "↩"
 *
 * Click navigates via `<a href="#/storage/<id>">` (hash-change ist History-Entry).
 */
function renderRefsSection(refs: KnowledgeObject['refs']): HTMLElement | null {
  const outgoing = refs?.outgoing ?? [];
  const incoming = refs?.incoming ?? [];
  if (outgoing.length === 0 && incoming.length === 0) return null;

  const details = document.createElement('details');
  details.className = 'storage-refs card';
  // Default collapsed — User reagiert auf Wunsch nach Kompaktheit.
  details.open = false;

  const summary = document.createElement('summary');
  summary.className = 'storage-refs-summary-row';
  const total = outgoing.length + incoming.length;
  summary.textContent = `🔗 Verknüpfungen (${total})`;
  details.appendChild(summary);

  const inner = document.createElement('div');
  inner.className = 'storage-refs-body';

  if (outgoing.length > 0) {
    inner.appendChild(renderChipGroup(outgoing, refLabelOutgoing));
  }
  if (incoming.length > 0) {
    inner.appendChild(renderChipGroup(incoming, refLabelIncoming));
  }

  if (refs?.truncated.outgoing || refs?.truncated.incoming) {
    const more = document.createElement('div');
    more.className = 'storage-refs-truncated';
    more.textContent = '… weitere nicht angezeigt';
    inner.appendChild(more);
  }

  details.appendChild(inner);
  return details;
}

function renderChipGroup(
  refs: ReadonlyArray<RefView>,
  labelFn: (role: string) => string,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'storage-refs-chip-row';
  for (const ref of refs) {
    row.appendChild(renderRefChip(ref, labelFn(ref.role)));
  }
  return row;
}

function refLabelOutgoing(role: string): string {
  switch (role) {
    case 'resource':
      return '📎';
    case 'references':
      return '↗';
    case 'depends_on':
      return '⚙';
    default:
      return '·';
  }
}

function refLabelIncoming(role: string): string {
  switch (role) {
    case 'resource':
      return '↩ Teil von';
    case 'references':
      return '↩ ref von';
    case 'depends_on':
      return '↩ benutzt von';
    default:
      return '↩';
  }
}

function renderRefChip(ref: RefView, prefix: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'storage-refs-chip';
  a.href = `#/storage/${ref.id}`;
  const title = stripIpiWrappers(ref.title ?? ref.id);
  a.textContent = `${prefix} ${title}`;
  if (ref.summary) {
    // Title-attribute = native tooltip on hover, no permanent visual clutter.
    a.title = stripIpiWrappers(ref.summary);
  }
  return a;
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

  // ─── Header: zwei Zeilen — oben Back + Action-Buttons, darunter Titel.
  // User-Wunsch (2026-05-17): 1-Zeilen-Layout war zu voll bei langen Titeln.
  // Pattern analog apps-detail (top-row + title underneath).
  const header = document.createElement('header');
  header.className = 'storage-detail-head';

  const topRow = document.createElement('div');
  topRow.className = 'storage-detail-top-row';

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'btn btn-secondary btn-small back-btn';
  back.textContent = '← Back';
  back.addEventListener('click', () => {
    window.location.hash = '#/storage';
  });
  topRow.appendChild(back);

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

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'icon-btn storage-delete-btn';
  delBtn.setAttribute('aria-label', `Object loeschen`);
  delBtn.setAttribute('title', 'Object loeschen');
  delBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>`;
  delBtn.addEventListener('click', () => {
    void handleDelete(api, obj, delBtn);
  });
  actions.appendChild(delBtn);

  topRow.appendChild(actions);
  header.appendChild(topRow);

  const title = document.createElement('h1');
  title.textContent = obj.title ?? obj.filename ?? obj.id;
  header.appendChild(title);

  main.appendChild(header);

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

  // ─── Summary — alle Subtypes außer app:* editierbar (User-Wunsch
  // 2026-05-17: "wieso kann ich nur bestimmte summary bearbeiten und
  // nicht alle"). Apps haben eigene State-Mgmt, daher excluded.
  const isApp = (obj.subtype ?? '').startsWith('app:');
  const hasDescription =
    obj.description !== undefined && obj.description !== null && obj.description !== '';
  if (!isApp && (hasDescription || true)) {
    // Auch bei leerem description rendern damit User auf ✏️ klicken kann.
    const summarySection = document.createElement('section');
    summarySection.className = 'storage-summary card';

    const pencil = document.createElement('button');
    pencil.type = 'button';
    pencil.className = 'edit-pencil';
    pencil.textContent = '✏️';
    pencil.title = 'Zusammenfassung bearbeiten';
    pencil.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openSummaryModal(api, obj);
    });
    summarySection.appendChild(pencil);

    const p = document.createElement('p');
    p.className = 'storage-summary-text';
    if (hasDescription) {
      p.textContent = stripIpiWrappers(obj.description!);
    } else {
      p.classList.add('muted', 'placeholder');
      p.textContent = 'Noch keine Zusammenfassung — Klick ✏️ zum Hinzufügen';
    }
    summarySection.appendChild(p);
    main.appendChild(summarySection);
  }

  // ─── Verknüpfungen (Refs) — PLAN-document-linking §10.5 D1.
  // Platzierung unter Summary (User-Wunsch): Summary gibt Kontext, dann
  // verlinkte Resources. Chips klickbar → Navigate. Eager-Bundle agent-side
  // via skills.get_bundle MCP-Tool.
  const refsSection = renderRefsSection(obj.refs);
  if (refsSection) {
    main.appendChild(refsSection);
  }

  // Body — nur rendern wenn tatsaechlich Body-Content da ist.
  // body===null/undefined (= server hat kein body geliefert) → kein Section.
  // body==='' (= leerer body) → kein Section.
  const hasBody = obj.body !== undefined && obj.body !== null && obj.body !== '';
  if (hasBody) {
    const bodySection = document.createElement('section');
    bodySection.className = 'storage-body card';

    // ─── Floating Action-Buttons über dem Body (User-Wunsch 2026-05-17).
    // Beide rechts oben in einem Flex-Container — Copy links, Edit-Pencil
    // ganz rechts. Transparent + hover-reveal damit sie den Content nicht
    // dominieren.
    const bodyActions = document.createElement('div');
    bodyActions.className = 'body-actions';

    const copyBodyBtn = document.createElement('button');
    copyBodyBtn.type = 'button';
    copyBodyBtn.className = 'icon-btn body-copy-btn';
    copyBodyBtn.title = 'Inhalt kopieren';
    copyBodyBtn.setAttribute('aria-label', 'Inhalt kopieren');
    copyBodyBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    copyBodyBtn.addEventListener('click', async () => {
      try {
        const text = stripIpiWrappers(decodeBody(obj));
        await navigator.clipboard.writeText(text);
        showToast('Inhalt kopiert');
      } catch {
        showToast('Kopieren fehlgeschlagen');
      }
    });
    bodyActions.appendChild(copyBodyBtn);

    if (isBodyTextEditable(obj)) {
      const editBodyBtn = document.createElement('button');
      editBodyBtn.type = 'button';
      editBodyBtn.className = 'edit-pencil body-edit-pencil';
      editBodyBtn.textContent = '✏️';
      editBodyBtn.title = 'Body bearbeiten';
      editBodyBtn.setAttribute('aria-label', 'Body bearbeiten');
      editBodyBtn.addEventListener('click', () => {
        openBodyModal(api, obj);
      });
      bodyActions.appendChild(editBodyBtn);
    }

    bodySection.appendChild(bodyActions);

    // Interaktiver List-Toggle (PLAN 2026-05-17 User-Wunsch): wenn der
    // body-renderer eine Liste ist, persistieren wir Checkbox-Ticks direkt
    // via PATCH /v1/knowledge/objects/:id mit neuem body. Optimistic UI:
    // renderer flippt sofort, revert nur bei API-Fehler.
    const rendered = dispatchRenderer(obj, {
      onListToggle: async ({ newBody }) => {
        try {
          await api.updateBody(obj.id, newBody);
        } catch (err) {
          showToast(`Tick fehlgeschlagen: ${(err as Error).message}`);
          throw err; // re-throw → renderer revert
        }
      },
    });
    walkAndStripIpi(rendered);

    if (!rendered.textContent || rendered.textContent.trim().length === 0) {
      // Renderer leer → decoded raw als pre
      const raw = decodeBody(obj);
      if (raw) {
        const pre = document.createElement('pre');
        pre.className = 'storage-body-pre';
        pre.textContent = stripIpiWrappers(raw);
        bodySection.appendChild(pre);
      }
    } else {
      bodySection.appendChild(rendered);
    }
    main.appendChild(bodySection);
  }
}

/**
 * Modal zum Editieren des Body-Inhalts. Bigger textarea als Summary,
 * keine Length-Constraints (Body kann lang sein). Speichert via
 * api.updateBody und triggert reload damit der gerenderte Markdown/Code
 * neu rendert.
 */
function openBodyModal(api: ApiStorageClient, obj: KnowledgeObject): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'storage-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'storage-modal storage-modal-large card';

  const h = document.createElement('h2');
  h.textContent = 'Inhalt bearbeiten';
  modal.appendChild(h);

  const hint = document.createElement('p');
  hint.className = 'muted small';
  const mime = obj.mimeType ?? obj.contentType ?? '';
  if (
    mime.startsWith('text/markdown') ||
    obj.subtype === 'note' ||
    obj.subtype === 'memo'
  ) {
    hint.textContent = 'Markdown — # Headings, **bold**, fenced ```code```, [Links](url).';
  } else if (mime) {
    hint.textContent = `Format: ${mime} — wird unverändert gespeichert.`;
  } else {
    hint.textContent = 'Plain text — wird unverändert gespeichert.';
  }
  modal.appendChild(hint);

  const textarea = document.createElement('textarea');
  const currentBody = stripIpiWrappers(decodeBody(obj));
  textarea.value = currentBody;
  textarea.rows = 22;
  textarea.className = 'storage-body-textarea';
  modal.appendChild(textarea);

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
  save.textContent = 'Speichern';
  save.addEventListener('click', () => {
    void (async () => {
      save.disabled = true;
      save.textContent = 'Sending…';
      try {
        await api.updateBody(obj.id, textarea.value);
        backdrop.remove();
        showToast('Gespeichert');
        reloadCurrentView();
      } catch (err) {
        save.disabled = false;
        save.textContent = 'Speichern';
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
  btn: HTMLButtonElement,
): Promise<void> {
  const label = obj.title ?? obj.filename ?? obj.id;
  const refcount = obj.refcount ?? 0;

  // Refcount=0 → einfacher Confirm.
  // Refcount>0 → zwei Stufen: erst Standard-Confirm, dann Force-Frage,
  //   weil ein "Force-Delete" andere Objekte beschädigen kann (incoming refs).
  if (refcount === 0) {
    if (!window.confirm(
      `Delete "${label}"?\n\nEin Approval-Request wird erstellt; du musst ihn in der Approval-Queue signen.`,
    )) {
      return;
    }
  } else {
    if (!window.confirm(
      `Delete "${label}"?\n\n` +
      `⚠ refcount=${refcount} — ${refcount} andere Objekt${refcount === 1 ? '' : 'e'} ` +
      `referenzier${refcount === 1 ? 't' : 'en'} dieses Objekt. Ein Force-Delete kann ` +
      `deren Refs hinterlassen.\n\nWeiter zur Force-Bestätigung?`,
    )) {
      return;
    }
    if (!window.confirm(
      `⚠ FORCE DELETE bestätigen: "${label}" trotz refcount=${refcount} löschen?`,
    )) {
      return;
    }
  }
  const force = refcount > 0;
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
  save.textContent = 'Speichern';
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
        showToast('Gespeichert');
        // Reload aktuelle Detail-View damit neue Summary sichtbar wird.
        reloadCurrentView();
      } catch (err) {
        save.disabled = false;
        save.textContent = 'Speichern';
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
