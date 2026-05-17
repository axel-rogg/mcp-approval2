/**
 * Approval-Sections-Renderer.
 *
 * Two render-paths:
 *  1. SECTIONED — wenn `displayRendered` (oder substituiertes `displayTemplate`)
 *     "=== Label ===" Marker enthaelt: split + render eine Karte pro Section
 *     (long bodies in <details>-Foldout). Visual identisch zu v1
 *     (mcp-approval/assets/app/approval-sections.js).
 *  2. FALLBACK — sonst die 4-Section-View ("What will happen / Data sent /
 *     Where it goes / Sensitivity") wie sie vor dem v1-Port war. Erlaubt
 *     migrierten Tools v1-Look + lasst unmigrated Tools weiterhin lesbar.
 *
 * WYSIWYS: das was wir anzeigen ist exakt der canonical display-string —
 * keine zusaetzliche Information, kein Reordering.
 */
import type { PendingApproval } from './api.js';

const SECTION_RE = /^=== (.+) ===$/;
const COLLAPSE_CHARS = 200;
const COLLAPSE_LINES = 3;
const SUMMARY_MAX = 80;

export interface Section {
  readonly label: string;
  readonly body: string;
}

export function renderSections(approval: PendingApproval): HTMLElement {
  const rendered = renderDisplay(approval);
  const sections = parseSections(rendered);
  if (sections) {
    return renderSectionedView(sections);
  }
  return renderFallbackView(approval);
}

/**
 * Split a "=== Label ===" string into [{label, body}]. Returns null if no
 * section header detected — caller falls back to the legacy view.
 */
export function parseSections(input: string | null): Section[] | null {
  if (!input || input.length === 0) return null;
  const lines = input.split('\n');
  const out: { label: string; body: string }[] = [];
  let current: { label: string; body: string } | null = null;
  for (const line of lines) {
    const m = SECTION_RE.exec(line);
    if (m && m[1]) {
      if (current) {
        current.body = current.body.replace(/\n+$/, '');
        out.push(current);
      }
      current = { label: m[1], body: '' };
    } else if (current) {
      current.body += (current.body ? '\n' : '') + line;
    }
    // Lines before the first === marker werden absichtlich verworfen.
  }
  if (current) {
    current.body = current.body.replace(/\n+$/, '');
    out.push(current);
  }
  return out.length > 0 ? out : null;
}

function renderSectionedView(sections: ReadonlyArray<Section>): HTMLElement {
  const host = document.createElement('div');
  host.className = 'sec-host';
  for (const s of sections) host.appendChild(renderSectionCard(s));
  return host;
}

function renderSectionCard(section: Section): HTMLElement {
  const card = document.createElement('div');
  card.className = 'sec-card';

  const label = document.createElement('div');
  label.className = 'sec-label';
  label.textContent = section.label;
  card.appendChild(label);

  if (shouldCollapse(section.body)) {
    const details = document.createElement('details');
    details.className = 'sec-details';

    const summary = document.createElement('summary');
    summary.className = 'sec-summary mono';
    summary.textContent = summaryFor(section.body) + ' …';
    details.appendChild(summary);

    const body = document.createElement('pre');
    body.className = 'sec-body mono sec-body-confined';
    body.textContent = section.body;
    details.appendChild(body);

    // "Im Popup oeffnen"-Button fuer voll-confined Reading.
    const actions = document.createElement('div');
    actions.className = 'sec-actions';
    const popupBtn = document.createElement('button');
    popupBtn.type = 'button';
    popupBtn.className = 'btn-small btn-link sec-popup-btn';
    popupBtn.textContent = '🔍 Im Popup oeffnen';
    popupBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openContentModal(section.label, section.body);
    });
    actions.appendChild(popupBtn);
    details.appendChild(actions);

    card.appendChild(details);
  } else {
    const body = document.createElement('pre');
    body.className = 'sec-body mono';
    body.textContent = section.body;
    card.appendChild(body);
  }

  return card;
}

/**
 * Modal-Lightbox fuer lange Section-Bodies (SQL/Markdown/etc.). ESC oder
 * Outside-Click schliessen. Mono-Pre mit internem Scroll, Copy-Button.
 *
 * WYSIWYS: das modal zeigt EXAKT denselben Body-Inhalt — keine zusaetzliche
 * Information.
 */
export function openContentModal(label: string, body: string): void {
  const overlay = document.createElement('div');
  overlay.className = 'sec-modal-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'sec-modal';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  const header = document.createElement('div');
  header.className = 'sec-modal-header';

  const title = document.createElement('span');
  title.className = 'sec-modal-title';
  title.textContent = label;
  header.appendChild(title);

  const right = document.createElement('div');
  right.className = 'sec-modal-actions';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'btn-small';
  copyBtn.textContent = '📋 Kopieren';
  copyBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(body);
      copyBtn.textContent = '✓ Kopiert';
      window.setTimeout(() => {
        copyBtn.textContent = '📋 Kopieren';
      }, 1500);
    } catch {
      copyBtn.textContent = '✗ Fehler';
    }
  });
  right.appendChild(copyBtn);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn-small';
  closeBtn.setAttribute('aria-label', 'Schliessen');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    close();
  });
  right.appendChild(closeBtn);

  header.appendChild(right);
  dialog.appendChild(header);

  const pre = document.createElement('pre');
  pre.className = 'sec-modal-body mono';
  pre.textContent = body;
  dialog.appendChild(pre);

  overlay.appendChild(dialog);

  function close(): void {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
  // Focus-trap-light: Close-Button kriegt den Focus
  closeBtn.focus();
}

function shouldCollapse(body: string): boolean {
  if (body.length > COLLAPSE_CHARS) return true;
  return body.split('\n').length > COLLAPSE_LINES;
}

function summaryFor(body: string): string {
  const firstLine = body.split('\n').find((l) => l.trim().length > 0) ?? '';
  return firstLine.length > SUMMARY_MAX
    ? firstLine.slice(0, SUMMARY_MAX) + '…'
    : firstLine;
}

// ────────────────────────────────────────────────────────────────────────────
// Fallback view — pre-port 4-section layout fuer un-migrated tools.
// ────────────────────────────────────────────────────────────────────────────

function renderFallbackView(approval: PendingApproval): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'approval-sections';

  wrap.appendChild(makeSection('What will happen', renderWhatHappens(approval), true));
  wrap.appendChild(makeSection('Data sent', renderDataSent(approval), false));

  const whereEl = renderWhereItGoes(approval);
  if (whereEl) {
    wrap.appendChild(makeSection('Where it goes', whereEl, false));
  }

  wrap.appendChild(makeSection('Sensitivity', renderSensitivity(approval), false));

  return wrap;
}

function makeSection(label: string, body: HTMLElement, openByDefault: boolean): HTMLElement {
  const details = document.createElement('details');
  details.className = 'approval-section';
  if (openByDefault) details.open = true;

  const summary = document.createElement('summary');
  summary.className = 'approval-section-summary';
  summary.textContent = label;
  details.appendChild(summary);

  const content = document.createElement('div');
  content.className = 'approval-section-content';
  content.appendChild(body);
  details.appendChild(content);

  return details;
}

function renderWhatHappens(approval: PendingApproval): HTMLElement {
  const p = document.createElement('p');
  const rendered = renderDisplay(approval);
  if (rendered) {
    p.textContent = rendered;
  } else {
    const code = document.createElement('code');
    code.textContent = approval.toolName;
    p.appendChild(document.createTextNode('Tool: '));
    p.appendChild(code);
  }
  return p;
}

function renderDataSent(approval: PendingApproval): HTMLElement {
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(approval.input ?? {}, null, 2);
  return pre;
}

function renderWhereItGoes(approval: PendingApproval): HTMLElement | null {
  const target = deriveTarget(approval.toolName);
  if (!target) return null;
  const wrap = document.createElement('div');
  const p = document.createElement('p');
  p.textContent = 'Service / surface: ';
  const code = document.createElement('code');
  code.textContent = target;
  p.appendChild(code);
  wrap.appendChild(p);
  return wrap;
}

function renderSensitivity(approval: PendingApproval): HTMLElement {
  const wrap = document.createElement('div');
  const badge = document.createElement('span');
  badge.className = `pill pill-${approval.sensitivity} sensitivity-badge sensitivity-${approval.sensitivity}`;
  badge.textContent = approval.sensitivity;
  wrap.appendChild(badge);

  const desc = document.createElement('p');
  desc.className = 'muted small';
  desc.textContent =
    approval.sensitivity === 'danger'
      ? 'Danger: irreversible side-effects (delete / overwrite / external send). Approval requires passkey-PRF.'
      : 'Write: state-changing, but reversible. Approval requires passkey signature.';
  wrap.appendChild(desc);
  return wrap;
}

/**
 * displayRendered (Server-Side Pre-Render) bevorzugen, sonst clientseitig
 * `{{path}}` aus displayTemplate substituieren.
 */
export function renderDisplay(approval: PendingApproval): string {
  const rendered = (approval as PendingApproval & { displayRendered?: unknown }).displayRendered;
  if (typeof rendered === 'string' && rendered.length > 0) return rendered;
  if (approval.displayTemplate) {
    return applyTemplate(approval.displayTemplate, approval.input);
  }
  return '';
}

function applyTemplate(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const segments = path.split('.');
    let cur: unknown = input;
    for (const seg of segments) {
      if (cur !== null && typeof cur === 'object' && seg in (cur as object)) {
        cur = (cur as Record<string, unknown>)[seg];
      } else {
        return '';
      }
    }
    return typeof cur === 'string' ? cur : JSON.stringify(cur);
  });
}

function deriveTarget(toolName: string): string | null {
  if (!toolName.includes('.') && !toolName.includes(':')) return null;
  const sep = toolName.includes(':') ? ':' : '.';
  const prefix = toolName.split(sep)[0];
  if (!prefix) return null;
  const map: Record<string, string> = {
    cf: 'Cloudflare',
    github: 'GitHub',
    gh: 'GitHub',
    gws: 'Google Workspace',
    gcloud: 'Google Cloud',
    slack: 'Slack',
    utils: 'Utilities',
    credentials: 'Vault (local)',
    docs: 'Knowledge store (local)',
    skills: 'Knowledge store (local)',
    apps: 'Apps (local)',
    memorize: 'Memo store (local)',
    prefs: 'User preferences (local)',
    test: 'Test surface',
  };
  return map[prefix] ?? prefix;
}
