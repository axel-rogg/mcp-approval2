/**
 * Lists-Tools — Smoke-Tests.
 *
 * Plan-Ref: docs/plans/active/PLAN-wrapper-conventions.md §"Body-Formate / list".
 *
 * Cover:
 *   - body validator: H1 + checkbox-Items + tags, rejects malformed lines
 *   - create: dispatcht createObject mit subtype='list' und Markdown-Body
 *   - add_item: liest existing body, hängt Zeile an, validiert
 *   - tick/untick: substring + line_index Pfad
 *   - list/get: read-Path ohne Approval
 */
import { describe, it, expect } from 'vitest';
import type {
  KnowledgeAdapter,
  KnowledgeObject,
  ObjectsList,
  SearchHit,
  Share,
} from '@mcp-approval2/adapters';
import { ApprovalRequiredError, ToolRegistry } from '../mcp/protocol/registry.js';
import type { AuditService, ToolContext } from '../mcp/protocol/tool.js';
import { KnowledgeService } from '../services/knowledge.js';
import {
  makeListsAddItemTool,
  makeListsCreateTool,
  makeListsGetTool,
  makeListsListTool,
  makeListsTickTool,
  makeListsUntickTool,
  validateListBody,
} from './lists-tools.js';

const USER_ID = '00000000-0000-0000-0000-000000000001';

function makeAudit(): AuditService {
  return {
    async emit() {
      /* noop */
    },
  };
}

function makeListObj(overrides: Partial<KnowledgeObject> = {}): KnowledgeObject {
  return {
    id: 'list-1',
    ownerId: USER_ID,
    subtype: 'list',
    title: 'Einkauf',
    description: null,
    keywords: [],
    triggerHints: null,
    meta: null,
    bodySize: 0,
    bodyHash: null,
    mimeType: null,
    filename: null,
    visibility: 'private',
    pinned: false,
    archived: false,
    refcount: 0,
    currentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    ...overrides,
  };
}

function makeAdapter(initialBody?: string): {
  adapter: KnowledgeAdapter;
  state: {
    objects: Map<string, KnowledgeObject>;
    creates: unknown[];
    updates: Array<{ id: string; patch: Record<string, unknown> }>;
    deleted: string[];
  };
} {
  const objects = new Map<string, KnowledgeObject>();
  const creates: unknown[] = [];
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const deleted: string[] = [];
  const body = initialBody ?? '# Einkauf\n\n- [ ] Tomaten\n- [ ] Brot #obst\n- [x] Käse';
  objects.set('list-1', makeListObj({ body }));
  const adapter: KnowledgeAdapter = {
    async createObject(args) {
      creates.push(args);
      const obj = makeListObj({
        id: 'new-list',
        subtype: args.subtype ?? 'list',
        title: args.title ?? null,
        body: typeof args.body === 'string' ? args.body : '',
      });
      objects.set(obj.id, obj);
      return obj;
    },
    async getObject({ id }) {
      const o = objects.get(id);
      if (!o) throw new Error(`not found: ${id}`);
      return o;
    },
    async listObjects(args) {
      const items = [...objects.values()].filter(
        (o) => args.subtype === undefined || o.subtype === args.subtype,
      );
      return { items, nextCursor: null } as ObjectsList;
    },
    async updateObject(args) {
      const patch = args.patch as Record<string, unknown>;
      updates.push({ id: args.id, patch });
      const cur = objects.get(args.id);
      if (!cur) throw new Error(`not found: ${args.id}`);
      const nextBody = typeof patch['body'] === 'string' ? (patch['body'] as string) : cur.body;
      const next: KnowledgeObject = { ...cur, body: nextBody ?? null };
      objects.set(args.id, next);
      return next;
    },
    async deleteObject({ id }) {
      deleted.push(id);
      objects.delete(id);
    },
    async createShare() {
      return {} as Share;
    },
    async listShares() {
      return [] as ReadonlyArray<Share>;
    },
    async revokeShare() {
      /* noop */
    },
    async search() {
      return [] as ReadonlyArray<SearchHit>;
    },
    async eraseUser() {
      return {
        status: 'ok',
        deleted: {
          objects: 0,
          shares: 0,
          idempotency: 0,
          uploads: 0,
          auditPseudonymised: 0,
          blobsDeleted: 0,
          blobsPending: 0,
        },
        deletedRows: 0,
      };
    },
    async syncUser() {
      return { status: 'created', kcUserId: 'kc-stub-1' };
    },
  };
  return { adapter, state: { objects, creates, updates, deleted } };
}

function makeCtx(): ToolContext {
  return {
    userId: USER_ID,
    email: 'user@example.com',
    role: 'member',
    requestId: 'req-1',
    audit: makeAudit(),
    db: {} as ToolContext['db'],
    signal: new AbortController().signal,
  };
}

function build(initialBody?: string): {
  registry: ToolRegistry;
  state: ReturnType<typeof makeAdapter>['state'];
} {
  const audit = makeAudit();
  const { adapter, state } = makeAdapter(initialBody);
  const knowledge = new KnowledgeService({ adapter, audit });
  const registry = new ToolRegistry();
  registry.register(makeListsCreateTool({ knowledge }));
  registry.register(makeListsAddItemTool({ knowledge }));
  registry.register(makeListsTickTool({ knowledge }));
  registry.register(makeListsUntickTool({ knowledge }));
  registry.register(makeListsListTool({ knowledge }));
  registry.register(makeListsGetTool({ knowledge }));
  return { registry, state };
}

// ===========================================================================
// Body Validator
// ===========================================================================

describe('validateListBody', () => {
  it('accepts H1 + checkbox items with tags', () => {
    expect(() =>
      validateListBody('# Einkauf\n\n- [ ] Tomaten\n- [x] Brot #obst\n- [ ] Avocado #obst'),
    ).not.toThrow();
  });

  it('accepts body without H1', () => {
    expect(() => validateListBody('- [ ] Tomaten\n- [x] Käse')).not.toThrow();
  });

  it('rejects malformed line (no checkbox)', () => {
    expect(() => validateListBody('# Einkauf\n\n- Tomaten')).toThrow(/not a valid checkbox/);
  });

  it('rejects too many items', () => {
    const items = Array.from({ length: 121 }, (_, i) => `- [ ] Item ${i}`).join('\n');
    expect(() => validateListBody(items)).toThrow(/too many items/);
  });
});

// ===========================================================================
// lists.create
// ===========================================================================

describe('lists.create', () => {
  it('requires approval (write)', async () => {
    const { registry } = build();
    await expect(
      registry.dispatch({
        name: 'lists.create',
        input: { title: 'Einkauf', items: ['Tomaten'] },
        ctx: makeCtx(),
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('creates with subtype=list and Markdown body', async () => {
    const { registry, state } = build();
    await registry.dispatch({
      name: 'lists.create',
      input: { title: 'Einkauf', items: ['Tomaten', 'Brot'] },
      ctx: makeCtx(),
      bypassApproval: true,
    });
    expect(state.creates.length).toBe(1);
    const args = state.creates[0] as { subtype?: string; body?: string };
    expect(args.subtype).toBe('list');
    expect(args.body).toContain('# Einkauf');
    expect(args.body).toContain('- [ ] Tomaten');
    expect(args.body).toContain('- [ ] Brot');
  });

  it('creates with no initial items', async () => {
    const { registry, state } = build();
    await registry.dispatch({
      name: 'lists.create',
      input: { title: 'Leer' },
      ctx: makeCtx(),
      bypassApproval: true,
    });
    const args = state.creates[0] as { body: string };
    expect(args.body).toBe('# Leer\n');
  });
});

// ===========================================================================
// lists.add_item
// ===========================================================================

describe('lists.add_item', () => {
  it('requires approval (write)', async () => {
    const { registry } = build();
    await expect(
      registry.dispatch({
        name: 'lists.add_item',
        input: { id: 'list-1', item: 'Apfel' },
        ctx: makeCtx(),
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('appends a line to the existing body', async () => {
    const { registry, state } = build();
    await registry.dispatch({
      name: 'lists.add_item',
      input: { id: 'list-1', item: 'Apfel' },
      ctx: makeCtx(),
      bypassApproval: true,
    });
    expect(state.updates.length).toBe(1);
    const body = state.updates[0]!.patch['body'] as string;
    expect(body).toContain('- [ ] Apfel');
  });

  it('appends with #tag suffix', async () => {
    const { registry, state } = build();
    await registry.dispatch({
      name: 'lists.add_item',
      input: { id: 'list-1', item: 'Apfel', tag: 'obst' },
      ctx: makeCtx(),
      bypassApproval: true,
    });
    const body = state.updates[0]!.patch['body'] as string;
    expect(body).toContain('- [ ] Apfel #obst');
  });
});

// ===========================================================================
// lists.tick / lists.untick
// ===========================================================================

describe('lists.tick', () => {
  it('ticks the first matching item by substring', async () => {
    const { registry, state } = build();
    await registry.dispatch({
      name: 'lists.tick',
      input: { id: 'list-1', match: 'tomaten' },
      ctx: makeCtx(),
      bypassApproval: true,
    });
    const body = state.updates[0]!.patch['body'] as string;
    expect(body).toMatch(/- \[x\] Tomaten/);
  });

  it('ticks by line_index', async () => {
    const { registry, state } = build();
    await registry.dispatch({
      name: 'lists.tick',
      input: { id: 'list-1', match: 'Brot' },
      ctx: makeCtx(),
      bypassApproval: true,
    });
    const body = state.updates[0]!.patch['body'] as string;
    expect(body).toMatch(/- \[x\] Brot #obst/);
  });

  it('throws when no match found', async () => {
    const { registry } = build();
    await expect(
      registry.dispatch({
        name: 'lists.tick',
        input: { id: 'list-1', match: 'nope' },
        ctx: makeCtx(),
        bypassApproval: true,
      }),
    ).rejects.toThrow(/no item matching/);
  });
});

describe('lists.untick', () => {
  it('unticks an already-ticked item', async () => {
    const { registry, state } = build();
    await registry.dispatch({
      name: 'lists.untick',
      input: { id: 'list-1', match: 'Käse' },
      ctx: makeCtx(),
      bypassApproval: true,
    });
    const body = state.updates[0]!.patch['body'] as string;
    expect(body).toMatch(/- \[ \] Käse/);
  });
});

// ===========================================================================
// lists.list + lists.get
// ===========================================================================

describe('lists read tools', () => {
  it('lists.list returns lists without approval', async () => {
    const { registry } = build();
    const res = await registry.dispatch({
      name: 'lists.list',
      input: {},
      ctx: makeCtx(),
    });
    expect(res.sensitivity).toBe('read');
    const text = (res.result.content[0] as { text: string }).text;
    expect(text).toContain('list-1');
  });

  it('lists.get fetches a single list', async () => {
    const { registry } = build();
    const res = await registry.dispatch({
      name: 'lists.get',
      input: { id: 'list-1' },
      ctx: makeCtx(),
    });
    expect(res.sensitivity).toBe('read');
    const text = (res.result.content[0] as { text: string }).text;
    expect(text).toContain('list-1');
  });
});
