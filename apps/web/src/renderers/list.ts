/**
 * Renderer für `list` — Markdown-Checkbox-Pattern.
 *
 * Input-Form (eine Zeile pro Item):
 *   # Optional Header
 *   - [ ] Item-Label [#tag1 #tag2]
 *   - [x] Erledigtes Item
 *
 * Output: `<ul class="checkbox-list">` mit disabled-Checkboxes (read-only,
 * Schreibzugriff per `lists.tick`-Tool ist Folge-PR).
 */

const HEADER_RE = /^#\s+(.+)$/;
const ITEM_RE = /^-\s+\[([ xX])\]\s+(.+?)((?:\s+#[a-z0-9_-]+)*)\s*$/;
const TAG_RE = /#([a-z0-9_-]+)/g;

interface ListItem {
  readonly checked: boolean;
  readonly label: string;
  readonly tags: ReadonlyArray<string>;
}

export function renderList(text: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'checkbox-list-wrapper';

  let header: string | null = null;
  const items: ListItem[] = [];

  for (const line of (text ?? '').split(/\r?\n/)) {
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
      items.push({ checked, label, tags });
    }
  }

  if (header !== null) {
    const h = document.createElement('h2');
    h.textContent = header;
    wrapper.appendChild(h);
  }

  const ul = document.createElement('ul');
  ul.className = 'checkbox-list';
  for (const item of items) {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.disabled = true;
    cb.checked = item.checked;
    li.appendChild(cb);
    const label = document.createElement('span');
    label.className = 'item-label';
    label.textContent = item.label;
    if (item.checked) label.classList.add('checked');
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
