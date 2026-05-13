/**
 * Storage-Browser-Liste — Object-Browser für alle Kinds (docs/skills/apps/memos).
 *
 * Hash-Route: `#/storage[?kind=doc&q=foo&embedded=embedded]`
 *
 * UX:
 *   - Filter-Chips für kinds (All, Docs, Skills, Apps, Memos)
 *   - Search-Input (debounced)
 *   - Embedded-Filter-Dropdown (nur embedded / nur ohne / alle)
 *   - Liste mit kind-Badge, title/filename, embedded-Pencil, refcount, updatedAt
 *   - Click → Detail-View (#/storage/<id>)
 *   - Load-more-Button bei nextCursor
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
  readonly kind: string | undefined;
  readonly q: string | undefined;
  readonly embeddedFlag: 'embedded' | 'not-embedded' | undefined;
}

const KIND_LABEL: Record<string, string> = {
  '': 'All',
  doc: 'Docs',
  skill: 'Skills',
  app: 'Apps',
  app_state: 'Apps',
  memo: 'Memos',
};

const KIND_ICON: Record<string, string> = {
  doc: '📄',
  skill: '🧠',
  app: '🧩',
  app_state: '🧩',
  memo: '💭',
};

const FILTER_CHIPS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'All' },
  { value: 'doc', label: 'Docs' },
  { value: 'skill', label: 'Skills' },
  { value: 'app', label: 'Apps' },
  { value: 'memo', label: 'Memos' },
];

export function parseFilters(hash: string): StorageFilters {
  // Hash forms: '#/storage', '#/storage?kind=doc&q=foo&embedded=embedded'
  const qIdx = hash.indexOf('?');
  if (qIdx < 0) return { kind: undefined, q: undefined, embeddedFlag: undefined };
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  const kind = params.get('kind') ?? undefined;
  const q = params.get('q') ?? undefined;
  const embedded = params.get('embedded');
  const embeddedFlag =
    embedded === 'embedded' || embedded === 'not-embedded' ? embedded : undefined;
  return {
    kind: kind && kind !== '' ? kind : undefined,
    q: q && q !== '' ? q : undefined,
    embeddedFlag,
  };
}

function buildHash(filters: StorageFilters): string {
  const params = new URLSearchParams();
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.q) params.set('q', filters.q);
  if (filters.embeddedFlag) params.set('embedded', filters.embeddedFlag);
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
      (filters.kind === undefined && chip.value === '') ||
      filters.kind === chip.value ||
      // 'app' chip matches both 'app' and 'app_state'
      (chip.value === 'app' && filters.kind === 'app_state');
    if (isActive) btn.classList.add('active');
    btn.dataset['kind'] = chip.value;
    btn.textContent = chip.label;
    btn.addEventListener('click', () => {
      const next: StorageFilters = {
        kind: chip.value === '' ? undefined : chip.value,
        q: filters.q,
        embeddedFlag: filters.embeddedFlag,
      };
      window.location.hash = buildHash(next);
    });
    nav.appendChild(btn);
  }
  header.appendChild(nav);

  // Search input
  const searchRow = document.createElement('div');
  searchRow.className = 'row storage-search-row';

  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Search…';
  search.className = 'storage-search';
  search.value = filters.q ?? '';

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  search.addEventListener('input', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const next: StorageFilters = {
        kind: filters.kind,
        q: search.value.trim() === '' ? undefined : search.value.trim(),
        embeddedFlag: filters.embeddedFlag,
      };
      window.location.hash = buildHash(next);
    }, 250);
  });
  searchRow.appendChild(search);

  // Embedded-Filter
  const flagSelect = document.createElement('select');
  flagSelect.className = 'storage-flag-filter';
  const flagOptions: ReadonlyArray<{ value: string; label: string }> = [
    { value: '', label: 'Alle' },
    { value: 'embedded', label: 'Nur embedded' },
    { value: 'not-embedded', label: 'Nur ohne Embedding' },
  ];
  for (const opt of flagOptions) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    if (filters.embeddedFlag === opt.value || (!filters.embeddedFlag && opt.value === '')) {
      o.selected = true;
    }
    flagSelect.appendChild(o);
  }
  flagSelect.addEventListener('change', () => {
    const v = flagSelect.value;
    const next: StorageFilters = {
      kind: filters.kind,
      q: filters.q,
      embeddedFlag: v === 'embedded' || v === 'not-embedded' ? v : undefined,
    };
    window.location.hash = buildHash(next);
  });
  searchRow.appendChild(flagSelect);

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
    const args: ListObjectsArgs = {
      limit: 50,
      ...(filters.kind ? { kind: filters.kind } : {}),
      ...(filters.q ? { q: filters.q } : {}),
      ...(filters.embeddedFlag ? { embeddedFlag: filters.embeddedFlag } : {}),
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

  const kindBadge = document.createElement('span');
  kindBadge.className = `pill kind-badge kind-${obj.kind}`;
  kindBadge.textContent = `${KIND_ICON[obj.kind] ?? '•'} ${KIND_LABEL[obj.kind] ?? obj.kind}`;
  head.appendChild(kindBadge);

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
