/**
 * Renderer für `list` — Markdown-Checkbox-Pattern.
 *
 * Input-Form (eine Zeile pro Item):
 *   # Optional Header
 *   - [ ] Item-Label [#tag1 #tag2]
 *   - [x] Erledigtes Item
 *
 * Output: `<ul class="checkbox-list">`.
 *
 * Interactive-Modus (PLAN 2026-05-17, User-Wunsch "Lists direkt abhaken"):
 * wenn `onToggle` übergeben wird, sind die Checkboxes klickbar. On change
 * → ruft onToggle(lineIndex, newChecked, newBody). Caller (storage-detail)
 * persistiert den new body via api.updateBody. Optimistic UI:
 * checkbox-state ist sofort visuell, revert geschieht nur bei API-Fehler.
 */

const HEADER_RE = /^#\s+(.+)$/;
const ITEM_RE = /^-\s+\[([ xX])\]\s+(.+?)((?:\s+#[a-z0-9_-]+)*)\s*$/;
const TAG_RE = /#([a-z0-9_-]+)/g;
const LINE_ITEM_RE = /^(\s*-\s+\[)([ xX])(\]\s+.+)$/;

interface ListItem {
  readonly checked: boolean;
  readonly label: string;
  readonly tags: ReadonlyArray<string>;
  /** 0-basierter Index der Zeile im Original-Body. */
  readonly lineIndex: number;
}

export interface ListToggleHandler {
  (args: { lineIndex: number; checked: boolean; newBody: string }): Promise<void>;
}

/**
 * Toggle a single checkbox-line in the body string. Returns the new body
 * with `[ ]` ↔ `[x]` flipped at `lineIndex` only. Other lines stay byte-
 * identical.
 */
export function toggleListLine(body: string, lineIndex: number, checked: boolean): string {
  const lines = body.split(/\r?\n/);
  const target = lines[lineIndex];
  if (target === undefined) return body;
  const m = LINE_ITEM_RE.exec(target);
  if (!m) return body;
  const replacement = `${m[1]}${checked ? 'x' : ' '}${m[3]}`;
  lines[lineIndex] = replacement;
  return lines.join('\n');
}

export function renderList(
  text: string,
  onToggle?: ListToggleHandler,
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'checkbox-list-wrapper';

  let header: string | null = null;
  const items: ListItem[] = [];

  const allLines = (text ?? '').split(/\r?\n/);
  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i] ?? '';
    const trimmed = line.trim();
    if (!trimmed) continue;
    const headerMatch = HEADER_RE.exec(trimmed);
    if (headerMatch && header === null && items.length === 0) {
      header = headerMatch[1] ?? '';
      continue;
    }
    const itemMatch = ITEM_RE.exec(trimmed);
    if (itemMatch) {
      const checked = itemMatch[1] !== ' ';
      const label = itemMatch[2] ?? '';
      const tags: string[] = [];
      const tagPart = itemMatch[3] ?? '';
      for (const m of tagPart.matchAll(TAG_RE)) {
        if (m[1]) tags.push(m[1]);
      }
      items.push({ checked, label, tags, lineIndex: i });
    }
  }

  if (header !== null) {
    const h = document.createElement('h2');
    h.textContent = header;
    wrapper.appendChild(h);
  }

  const ul = document.createElement('ul');
  ul.className = 'checkbox-list';
  // Mutable reference to the latest body — captured by closures so that
  // multi-tick chains use the freshest version. We update this on every
  // successful toggle.
  let currentBody = text ?? '';

  for (const item of items) {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = item.checked;
    cb.disabled = onToggle === undefined;

    const label = document.createElement('span');
    label.className = 'item-label';
    label.textContent = item.label;
    if (item.checked) label.classList.add('checked');

    if (onToggle !== undefined) {
      cb.addEventListener('change', async () => {
        const newChecked = cb.checked;
        // Optimistic UI
        label.classList.toggle('checked', newChecked);
        cb.disabled = true; // re-enable nach API-Antwort
        const newBody = toggleListLine(currentBody, item.lineIndex, newChecked);
        try {
          await onToggle({ lineIndex: item.lineIndex, checked: newChecked, newBody });
          currentBody = newBody;
          cb.disabled = false;
        } catch {
          // Revert UI
          cb.checked = !newChecked;
          label.classList.toggle('checked', !newChecked);
          cb.disabled = false;
        }
      });
    }

    li.appendChild(cb);
    li.appendChild(label);
    for (const t of item.tags) {
      const tagEl = document.createElement('span');
      tagEl.className = 'tag';
      tagEl.textContent = t;
      li.appendChild(tagEl);
    }
    ul.appendChild(li);
  }
  wrapper.appendChild(ul);
  return wrapper;
}
