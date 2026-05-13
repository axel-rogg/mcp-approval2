/**
 * In-Memory Debug-Log + Hash-Route '#/debug'-Viewer.
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Burst 7 (PWA).
 *
 * Verantwortung:
 *   - `debug(...args)` ist ein eingeschlossener Ring-Buffer der letzten 500
 *     Log-Zeilen (FIFO). Konsolen-Output bleibt erhalten (mirror), wir wollen
 *     keinen Replacement der DevTools — nur einen In-App-Viewer fuer Pilot-User
 *     auf Mobile, wo sich console.log schlecht inspecten laesst.
 *   - `renderDebugLog(root)` rendert den Buffer + Clear-Button.
 *
 * Side-effect-free import — der Buffer entsteht beim ersten `debug()`-Call.
 */

const MAX_ENTRIES = 500;
const buffer: string[] = [];

export function debug(...args: unknown[]): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${args.map(stringify).join(' ')}`;
  buffer.push(line);
  if (buffer.length > MAX_ENTRIES) buffer.shift();
  // Mirror to console so dev-tools still works.
  try {
    // eslint-disable-next-line no-console
    console.debug('[pwa]', ...args);
  } catch {
    // ignore — some test harnesses null out console
  }
}

export function getDebugBuffer(): readonly string[] {
  return buffer;
}

export function clearDebugBuffer(): void {
  buffer.length = 0;
}

function stringify(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Render the debug-log into `root`. Idempotent — re-call to refresh.
 */
export function renderDebugLog(root: HTMLElement): void {
  root.innerHTML = '';
  const main = document.createElement('main');
  main.className = 'debug-log';

  const h1 = document.createElement('h1');
  h1.textContent = 'Debug Log';
  main.appendChild(h1);

  const help = document.createElement('p');
  help.className = 'muted';
  help.textContent = `Last ${MAX_ENTRIES} entries (newest at bottom). In-memory only — cleared on reload.`;
  main.appendChild(help);

  const actions = document.createElement('div');
  actions.className = 'actions';

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = 'Clear';
  clearBtn.addEventListener('click', () => {
    clearDebugBuffer();
    renderDebugLog(root);
  });
  actions.appendChild(clearBtn);

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.textContent = 'Refresh';
  refreshBtn.addEventListener('click', () => renderDebugLog(root));
  actions.appendChild(refreshBtn);

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => {
    void copyToClipboard(buffer.join('\n'));
  });
  actions.appendChild(copyBtn);

  main.appendChild(actions);

  const pre = document.createElement('pre');
  pre.id = 'log-output';
  pre.className = 'debug-output';
  pre.textContent = buffer.length > 0 ? buffer.join('\n') : '(empty)';
  main.appendChild(pre);

  root.appendChild(main);
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // fall through to legacy path
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'absolute';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } catch {
    // ignore
  }
  document.body.removeChild(ta);
}
