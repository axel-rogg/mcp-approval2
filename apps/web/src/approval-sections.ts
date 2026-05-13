/**
 * Approval-Sections-Renderer — strukturiert Detail-View in 4 Sections.
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Phase 4 (WYSIWYS).
 *
 * Sections (alle <details>-collapsible):
 *   1. What will happen        — rendered display_template ODER toolName-Fallback
 *   2. Data sent               — pretty-printed Tool-Input
 *   3. Where it goes           — service-host falls aus toolName ableitbar
 *   4. Sensitivity             — write / danger Erklaerung
 *
 * Wir tolerieren ein optionales `displayRendered` Feld (vom Hub schon
 * gerendertes Template); fallback auf clientseitige `{{path}}`-Template-
 * Substitution wenn nur `displayTemplate + input` da sind.
 */
import type { PendingApproval } from './api.js';

export function renderSections(approval: PendingApproval): HTMLElement {
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
 * Server liefert idealerweise `displayRendered` (Pre-Substitution). Fallback:
 * clientseitig die `{{path}}` Platzhalter aus dem displayTemplate ersetzen.
 */
function renderDisplay(approval: PendingApproval): string {
  // Some backends might attach a pre-rendered `displayRendered` field.
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

/**
 * Tool-Name → surface guess. `cf.workers.put` → cloudflare, `gws:gmail.send`
 * → google-workspace, `slack.send` → slack. Reine UX-Hilfe, kein Security-
 * Statement.
 */
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
  };
  return map[prefix] ?? prefix;
}
