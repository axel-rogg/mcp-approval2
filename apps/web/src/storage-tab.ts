/**
 * Storage-Browser-Liste — Object-Browser für alle Subtypes (file, skill_manifest, app:..., memo).
 *
 * Hash-Route: `#/storage[?subtype=doc&q=foo&embedded=embedded]`
 *
 * UX:
 *   - Filter-Chips für Subtypes (All, Docs, Skills, Apps, Memos)
 *   - Search-Input (debounced)
 *   - Embedded-Filter-Dropdown (nur embedded / nur ohne / alle)
 *   - Liste mit subtype-Badge, title/filename, embedded-Pencil, refcount, updatedAt
 *   - Click → Detail-View (#/storage/<id>)
 *   - Load-more-Button bei nextCursor
 *
 * Generic-Object-Model (v3): kein `kind` mehr; alles über free-form `subtype`.
 * Apps werden via Namespace-Prefix erkannt: `subtype.startsWith('app:')`.
 *
 * Plan-Ref: PLAN-data-browser-phase-b (Delete + Force-Toggle), PLAN-docs-embedding (Edit-Pencil).
 */
import type {
  ApiStorageClient,
  KnowledgeObject,
  ListObjectsArgs,
  ListObjectsResult,
} from './api-storage.js';
import type { ApiClient, Session } from './api.js';
import { logout } from './auth.js';
import { renderHeader } from './components/header.js';
import { renderEmptyState } from './components/empty-state.js';

interface StorageFilters {
  readonly subtype: string | undefined;
  readonly q: string | undefined;
}

/** Apps-Filter-Sentinel — matched alle subtypes mit `app:`-Prefix. */
const APP_FILTER = 'app:*';

const SUBTYPE_LABEL: Record<string, string> = {
  '': 'All',
  doc: 'Docs',
  file: 'Docs', // Legacy-Alias (pre-ADR-0004 renaming)
  skill_manifest: 'Skills',
  memo: 'Memos',
  list: 'Lists',
  note: 'Notes',
  [APP_FILTER]: 'Apps',
};

// Icon-Konvention: farbig + visuell unterscheidbar. Bevorzugung von
// Emoji-Glyphen die in den meisten OS-Renderern (Apple/Twemoji/Noto)
// Farbe haben. Vorher waren `file: '📄'` (graue Seite) und `list: '☑'`
// (schwarzer Haken) — beide farblos. Plus key-mismatch: FILTER_CHIPS
// verwendet `doc`, der Icon-Map hatte aber nur `file` → Default-Fallback.
const SUBTYPE_ICON: Record<string, string> = {
  doc: '📘',          // blaues Buch
  file: '📘',         // Legacy-Alias
  skill_manifest: '🧠',
  memo: '💭',
  list: '📋',         // Klemmbrett (mit Liste drauf)
  note: '📝',
};

const FILTER_CHIPS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'All' },
  { value: 'doc', label: 'Docs' },
  { value: 'skill_manifest', label: 'Skills' },
  { value: APP_FILTER, label: 'Apps' },
  { value: 'memo', label: 'Memos' },
  { value: 'list', label: 'Lists' },
  { value: 'note', label: 'Notes' },
];

function subtypeLabel(subtype: string | null | undefined): string {
  if (!subtype) return '–';
  if (SUBTYPE_LABEL[subtype]) return SUBTYPE_LABEL[subtype]!;
  if (subtype.startsWith('app:')) return 'Apps';
  return subtype;
}

function subtypeIcon(subtype: string | null | undefined): string {
  if (!subtype) return '•';
  if (SUBTYPE_ICON[subtype]) return SUBTYPE_ICON[subtype]!;
  if (subtype.startsWith('app:')) return '🧩';
  return '•';
}

export function parseFilters(hash: string): StorageFilters {
  // Hash forms: '#/storage', '#/storage?subtype=doc&q=foo'
  const qIdx = hash.indexOf('?');
  if (qIdx < 0) return { subtype: undefined, q: undefined };
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  const subtype = params.get('subtype') ?? undefined;
  const q = params.get('q') ?? undefined;
  return {
    subtype: subtype && subtype !== '' ? subtype : undefined,
    q: q && q !== '' ? q : undefined,
  };
}

function buildHash(filters: StorageFilters): string {
  const params = new URLSearchParams();
  if (filters.subtype) params.set('subtype', filters.subtype);
  if (filters.q) params.set('q', filters.q);
  const qs = params.toString();
  return qs ? `#/storage?${qs}` : '#/storage';
}

export async function renderStorageTab(
  root: HTMLElement,
  api: ApiStorageClient,
  authApi: ApiClient,
  session: Session,
): Promise<void> {
  root.innerHTML = '';
  renderHeader(root, session, () => void logout(authApi));

  const filters = parseFilters(window.location.hash);

  const main = document.createElement('main');
  main.className = 'storage-tab';

  const header = document.createElement('header');
  header.className = 'storage-header';

  const h1 = document.createElement('h1');
  h1.textContent = 'Storage';
  header.appendChild(h1);

  // Filter-Chips
  const nav = document.createElement('nav');
  nav.className = 'storage-filters';
  for (const chip of FILTER_CHIPS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'storage-chip';
    const isActive =
      (filters.subtype === undefined && chip.value === '') || filters.subtype === chip.value;
    if (isActive) btn.classList.add('active');
    btn.dataset['subtype'] = chip.value;
    // Icon + Label: subtypeIcon kennt auch APP_FILTER (app:*-Prefix → 🧩).
    // 'All' (chip.value='') hat kein Icon — bewusst, damit der Chip leicht
    // als "kein Filter aktiv" erkennbar bleibt.
    if (chip.value !== '') {
      const iconSpan = document.createElement('span');
      iconSpan.className = 'storage-chip-icon';
      iconSpan.textContent = subtypeIcon(chip.value);
      iconSpan.setAttribute('aria-hidden', 'true');
      btn.appendChild(iconSpan);
      btn.appendChild(document.createTextNode(' ' + chip.label));
    } else {
      btn.textContent = chip.label;
    }
    btn.addEventListener('click', () => {
      const next: StorageFilters = {
        subtype: chip.value === '' ? undefined : chip.value,
        q: filters.q,
      };
      window.location.hash = buildHash(next);
    });
    nav.appendChild(btn);
  }
  header.appendChild(nav);

  // Search input — geht IMMER ueber alles (kein embedded/non-embedded-Filter).
  // User-Entscheidung 2026-05-17: Suche soll Search-Index-agnostisch sein,
  // egal ob ein Item vector-embedded ist oder nur in FTS5.
  const searchRow = document.createElement('div');
  searchRow.className = 'row storage-search-row';

  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Search…';
  search.className = 'storage-search';
  search.value = filters.q ?? '';

  // Search-Input: 350ms-Debounce, dann nur die LISTE neu laden — NICHT
  // window.location.hash setzen (das wuerde hashchange triggern, boot()
  // wuerde das ganze PWA re-rendern, Input-Element wuerde zerstoert,
  // Focus geht verloren, User kann nicht weiterscheiben).
  //
  // Stattdessen: history.replaceState() updated die URL still (kein
  // hashchange-Event), und loadAndRender(api, ...) refreshed nur die
  // <ul.storage-list>. Das Input bleibt fokussiert.
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  search.addEventListener('input', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const q = search.value.trim() === '' ? undefined : search.value.trim();
      const next: StorageFilters = { subtype: filters.subtype, q };
      // Mutate filters in-place damit der Caller im naechsten loadAndRender
      // den aktuellen Stand bekommt. Plus URL still updaten als Bookmark-
      // State (kein Re-Render).
      (filters as { q: string | undefined }).q = q;
      const newHash = buildHash(next);
      history.replaceState(null, '', newHash);
      void loadAndRender(api, filters, listEl, footer, false);
    }, 350);
  });
  searchRow.appendChild(search);

  header.appendChild(searchRow);
  main.appendChild(header);

  // List section
  const listEl = document.createElement('ul');
  listEl.className = 'storage-list';
  listEl.id = 'storage-list';
  main.appendChild(listEl);

  // Load-more / status
  const footer = document.createElement('div');
  footer.className = 'storage-footer';
  footer.id = 'storage-footer';
  main.appendChild(footer);

  root.appendChild(main);

  await loadAndRender(api, filters, listEl, footer, false);
}

async function loadAndRender(
  api: ApiStorageClient,
  filters: StorageFilters,
  listEl: HTMLElement,
  footer: HTMLElement,
  append: boolean,
  cursor?: number,
): Promise<void> {
  if (!append) {
    listEl.innerHTML = '<li class="storage-loading muted">Loading…</li>';
    footer.innerHTML = '';
  }

  try {
    // Apps-Filter (`app:*`) ist ein URL-Sentinel — er wird im API-Call zum
    // server-side `subtype_prefix=app:` (KC2 macht `LIKE 'app:%'`). Kein
    // client-side narrowing mehr noetig.
    const isAppsFilter = filters.subtype === APP_FILTER;
    const args: ListObjectsArgs = {
      limit: 50,
      ...(filters.subtype && !isAppsFilter ? { subtype: filters.subtype } : {}),
      ...(isAppsFilter ? { subtypePrefix: 'app:' } : {}),
      ...(filters.q ? { q: filters.q } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    };
    const result: ListObjectsResult = await api.listObjects(args);

    if (!append) listEl.innerHTML = '';

    if (result.items.length === 0 && !append) {
      listEl.appendChild(
        (() => {
          const li = document.createElement('li');
          li.className = 'storage-empty';
          li.appendChild(
            renderEmptyState({
              title: 'Keine Objekte gefunden',
              body: filters.q ? `Keine Treffer für "${filters.q}".` : 'Storage ist leer.',
            }),
          );
          return li;
        })(),
      );
      return;
    }

    for (const obj of result.items) {
      listEl.appendChild(renderObjectRow(obj));
    }

    footer.innerHTML = '';
    if (result.nextCursor != null) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-secondary';
      btn.textContent = 'Load more';
      const nextCursor = result.nextCursor;
      btn.addEventListener('click', () => {
        btn.disabled = true;
        btn.textContent = 'Loading…';
        void loadAndRender(api, filters, listEl, footer, true, nextCursor);
      });
      footer.appendChild(btn);
    }
  } catch (err) {
    listEl.innerHTML = '';
    const errEl = document.createElement('li');
    errEl.className = 'err';
    errEl.textContent = `Fehler: ${(err as Error).message}`;
    listEl.appendChild(errEl);
  }
}

function renderObjectRow(obj: KnowledgeObject): HTMLElement {
  const li = document.createElement('li');
  li.className = 'storage-row card';
  li.dataset['id'] = obj.id;
  li.tabIndex = 0;
  li.setAttribute('role', 'link');

  const head = document.createElement('div');
  head.className = 'row storage-row-head';

  const subtypeBadge = document.createElement('span');
  subtypeBadge.className = 'pill subtype-badge';
  if (obj.subtype) subtypeBadge.dataset['subtype'] = obj.subtype;
  subtypeBadge.textContent = `${subtypeIcon(obj.subtype)} ${subtypeLabel(obj.subtype)}`;
  head.appendChild(subtypeBadge);

  const title = document.createElement('strong');
  title.className = 'storage-row-title';
  title.textContent = obj.title ?? obj.filename ?? obj.id;
  head.appendChild(title);

  if (obj.metaJson && (obj.metaJson as { embedded?: unknown })['embedded']) {
    const pencil = document.createElement('span');
    pencil.className = 'pill pill-ok';
    pencil.title = 'embedded (Vectorize)';
    pencil.textContent = '📝';
    head.appendChild(pencil);
  }

  li.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'muted small storage-row-meta';
  const subParts: string[] = [];
  if (obj.subtype) subParts.push(obj.subtype);
  if (typeof obj.refcount === 'number' && obj.refcount > 0) {
    subParts.push(`${obj.refcount} ref${obj.refcount === 1 ? '' : 's'}`);
  }
  if (obj.updatedAt) {
    subParts.push(new Date(obj.updatedAt).toLocaleString());
  }
  meta.textContent = subParts.join(' · ');
  li.appendChild(meta);

  const navigate = (): void => {
    window.location.hash = `#/storage/${encodeURIComponent(obj.id)}`;
  };
  li.addEventListener('click', navigate);
  li.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      navigate();
    }
  });

  return li;
}
