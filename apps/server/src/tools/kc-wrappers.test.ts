/**
 * KC-Wrapper-Tools — Smoke-Tests.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2.1 + §11
 *
 * Pro Tool wird geprueft:
 *   - Tool ist registriert
 *   - Input-Schema validates (sample input parses)
 *   - Read-Tools: dispatch funktioniert ohne Approval → returns expected result
 *   - Write/Danger-Tools: dispatch ohne bypass throws ApprovalRequiredError
 *   - Write/Danger-Tools: dispatch MIT bypass=true forwards to KnowledgeService
 *
 * Wir mocken den KnowledgeAdapter (in-memory) und bauen einen KnowledgeService
 * gegen den Stub. Damit lassen sich die Wrapper end-to-end testen ohne HTTP.
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
import { registerKcWrapperTools, type KcWrapperDeps } from './kc-wrappers-index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = '00000000-0000-0000-0000-000000000001';

function makeAudit(): AuditService & {
  events: Array<{ action: string; result: string }>;
} {
  const events: Array<{ action: string; result: string }> = [];
  return {
    events,
    async emit(ev) {
      events.push({ action: ev.action, result: ev.result });
    },
  };
}

function makeDoc(overrides: Partial<KnowledgeObject> = {}): KnowledgeObject {
  return {
    id: 'doc-1',
    ownerId: USER_ID,
    subtype: 'doc',
    title: 'Stub Doc',
    description: null,
    keywords: [],
    triggerHints: null,
    meta: null,
    bodySize: 4,
    bodyHash: null,
    mimeType: 'text/markdown',
    filename: 'stub.md',
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

function makeSkill(overrides: Partial<KnowledgeObject> = {}): KnowledgeObject {
  return makeDoc({
    id: 'skill-1',
    subtype: 'skill_manifest',
    title: 'Stub Skill',
    filename: null,
    mimeType: null,
    ...overrides,
  });
}

function makeAdapter(): {
  adapter: KnowledgeAdapter;
  state: {
    objects: Map<string, KnowledgeObject>;
    deleted: string[];
    updates: Array<{ id: string; patch: unknown }>;
  };
} {
  const objects = new Map<string, KnowledgeObject>();
  const deleted: string[] = [];
  const updates: Array<{ id: string; patch: unknown }> = [];

  const doc = makeDoc();
  const skill = makeSkill({ meta: { resource_ids: ['doc-1'] } });
  objects.set(doc.id, doc);
  objects.set(skill.id, skill);

  const share: Share = {
    id: 'share-1',
    resourceId: 'doc-1',
    grantedBy: USER_ID,
    grantedTo: 'user-2',
    scope: 'read',
    grantedAt: 1,
    expiresAt: null,
    revokedAt: null,
  };

  const hits: ReadonlyArray<SearchHit> = [
    {
      id: 'doc-1',
      subtype: 'doc',
      title: 'Stub Doc',
      score: 0.9,
      ftsRank: 0.5,
      vectorScore: 0.4,
    },
    {
      id: 'memo-1',
      subtype: 'memo',
      title: 'memorize hit',
      score: 0.7,
      ftsRank: null,
      vectorScore: 0.7,
    },
    {
      id: 'skill-1',
      subtype: 'skill_manifest',
      title: 'Stub Skill',
      score: 0.5,
      ftsRank: 0.5,
      vectorScore: 0.5,
    },
  ];

  const adapter: KnowledgeAdapter = {
    async createObject(args) {
      // Map canonical subtypes back to legacy IDs the tests expect:
      //   'doc' → 'new-doc', 'skill_manifest' → 'new-skill', 'memo' → 'new-memo'.
      const newIdSuffix =
        args.subtype === 'doc' ? 'doc'
        : args.subtype === 'skill_manifest' ? 'skill'
        : args.subtype === 'memo' ? 'memo'
        : args.subtype ?? 'object';
      const obj = makeDoc({
        id: `new-${newIdSuffix}`,
        title: args.title ?? null,
        ...(args.subtype !== undefined ? { subtype: args.subtype } : {}),
        ...(args.filename !== undefined ? { filename: args.filename } : {}),
        ...(args.mimeType !== undefined ? { mimeType: args.mimeType } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.keywords !== undefined ? { keywords: args.keywords } : {}),
        ...(args.meta !== undefined ? { meta: args.meta } : {}),
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
      updates.push({ id: args.id, patch: args.patch });
      const cur = objects.get(args.id);
      if (!cur) throw new Error(`not found: ${args.id}`);
      const meta = (args.patch as { meta?: Record<string, unknown> | null }).meta;
      const next: KnowledgeObject = {
        ...cur,
        ...(meta !== undefined ? { meta } : {}),
      };
      objects.set(args.id, next);
      return next;
    },
    async deleteObject({ id }) {
      deleted.push(id);
      objects.delete(id);
    },
    async createShare() {
      return share;
    },
    async listShares() {
      return [share];
    },
    async revokeShare() {
      /* noop */
    },
    async search(args) {
      const sts = args.subtypes;
      if (sts === undefined) return hits;
      return hits.filter((h) => h.subtype != null && sts.includes(h.subtype));
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
  return { adapter, state: { objects, deleted, updates } };
}

function makeCtx(audit: AuditService): ToolContext {
  return {
    userId: USER_ID,
    email: 'user@example.com',
    role: 'member',
    requestId: 'req-1',
    audit,
    db: {} as ToolContext['db'],
    signal: new AbortController().signal,
  };
}

function buildRegistry(): {
  registry: ToolRegistry;
  deps: KcWrapperDeps;
  state: ReturnType<typeof makeAdapter>['state'];
  audit: ReturnType<typeof makeAudit>;
} {
  const audit = makeAudit();
  const { adapter, state } = makeAdapter();
  const knowledge = new KnowledgeService({ adapter, audit });
  const deps: KcWrapperDeps = { knowledge };
  const registry = new ToolRegistry();
  registerKcWrapperTools(registry, deps);
  return { registry, deps, state, audit };
}

// ===========================================================================
// Registration smoke
// ===========================================================================

describe('registerKcWrapperTools — registration', () => {
  it('registers all 40 KC-wrapper tools', () => {
    const { registry } = buildRegistry();
    const names = registry.list().map((t) => t.name);
    expect(names.sort()).toEqual(
      [
        'docs.put',
        'docs.get',
        'docs.list',
        'docs.delete',
        'docs.usages',
        'docs.attach_to',
        'docs.update_summary',
        'skills.put',
        'skills.get',
        'skills.list',
        'skills.delete',
        'skills.search',
        'skills.read_resource',
        'skills.attach_resource',
        'memorize.add',
        'memorize.search',
        'memorize.list_recent',
        'memorize.delete',
        'objects.list',
        'objects.read',
        'lists.create',
        'lists.add_item',
        'lists.tick',
        'lists.untick',
        'lists.list',
        'lists.get',
        'notes.create',
        'notes.update',
        'notes.list',
        'notes.get',
        'notes.delete',
        'bookmarks.create',
        'bookmarks.list',
        'bookmarks.get',
        'bookmarks.delete',
        'recipes.create',
        'recipes.update',
        'recipes.list',
        'recipes.get',
        'recipes.delete',
      ].sort(),
    );
    expect(registry.size()).toBe(40);
  });

  it('exposes correct sensitivity annotations', () => {
    const { registry } = buildRegistry();
    const meta = registry.list();
    const get = (name: string) => meta.find((t) => t.name === name);

    // read-tools
    for (const name of [
      'docs.get',
      'docs.list',
      'docs.usages',
      'skills.get',
      'skills.list',
      'skills.search',
      'skills.read_resource',
      'memorize.search',
      'memorize.list_recent',
      'objects.list',
      'objects.read',
    ]) {
      expect(get(name)?.annotations?.sensitivity).toBe('read');
      expect(get(name)?.annotations?.readOnlyHint).toBe(true);
    }

    // write-tools
    for (const name of [
      'docs.put',
      'docs.attach_to',
      'docs.update_summary',
      'skills.put',
      'skills.attach_resource',
      'memorize.add',
    ]) {
      expect(get(name)?.annotations?.sensitivity).toBe('write');
      expect(get(name)?.annotations?.destructiveHint).toBe(false);
    }

    // danger-tools
    for (const name of ['docs.delete', 'skills.delete', 'memorize.delete']) {
      expect(get(name)?.annotations?.sensitivity).toBe('danger');
      expect(get(name)?.annotations?.destructiveHint).toBe(true);
    }
  });

  it('write/danger tools have a displayTemplate', () => {
    const { registry } = buildRegistry();
    const meta = registry.list();
    const writeOrDanger = [
      'docs.put',
      'docs.delete',
      'docs.attach_to',
      'docs.update_summary',
      'skills.put',
      'skills.delete',
      'skills.attach_resource',
      'memorize.add',
      'memorize.delete',
    ];
    for (const name of writeOrDanger) {
      const t = meta.find((m) => m.name === name);
      expect(t?.annotations?.displayTemplate, name).toBeTruthy();
      expect((t?.annotations?.displayTemplate as string).length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// docs.* tools
// ===========================================================================

describe('docs tools', () => {
  it('docs.put requires approval (write)', async () => {
    const { registry } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    await expect(
      registry.dispatch({
        name: 'docs.put',
        input: { filename: 'a.md', body: 'hello world' },
        ctx,
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('docs.put with bypass creates a new doc', async () => {
    const { registry, state } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    const res = await registry.dispatch({
      name: 'docs.put',
      input: { filename: 'a.md', body: 'hello world', summary: 'short' },
      ctx,
      bypassApproval: true,
    });
    expect(res.toolName).toBe('docs.put');
    // The stub returns "new-doc"
    expect(state.objects.has('new-doc')).toBe(true);
  });

  it('docs.put with id forwards to updateObject', async () => {
    const { registry, state } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    await registry.dispatch({
      name: 'docs.put',
      input: { id: 'doc-1', filename: 'updated.md', body: 'v2', summary: 's' },
      ctx,
      bypassApproval: true,
    });
    expect(state.updates.length).toBeGreaterThan(0);
    expect(state.updates[0]?.id).toBe('doc-1');
  });

  it('docs.get reads a doc without approval', async () => {
    const { registry } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    const res = await registry.dispatch({
      name: 'docs.get',
      input: { id: 'doc-1' },
      ctx,
    });
    expect(res.sensitivity).toBe('read');
    expect(res.result.content[0]?.type).toBe('text');
  });

  it('docs.list returns paginated list', async () => {
    const { registry } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    const res = await registry.dispatch({
      name: 'docs.list',
      input: { limit: 50 },
      ctx,
    });
    const text = (res.result.content[0] as { text: string }).text;
    expect(text).toContain('doc-1');
  });

  it('docs.delete throws without force if refcount>0', async () => {
    const { registry, state } = buildRegistry();
    // Bump refcount
    state.objects.set('doc-1', makeDoc({ refcount: 2 }));
    const ctx = makeCtx(makeAudit());
    await expect(
      registry.dispatch({
        name: 'docs.delete',
        input: { id: 'doc-1' },
        ctx,
        bypassApproval: true,
      }),
    ).rejects.toThrow(/still referenced/);
  });

  it('docs.delete with force=true deletes the doc', async () => {
    const { registry, state } = buildRegistry();
    state.objects.set('doc-1', makeDoc({ refcount: 2 }));
    const ctx = makeCtx(makeAudit());
    await registry.dispatch({
      name: 'docs.delete',
      input: { id: 'doc-1', force: true },
      ctx,
      bypassApproval: true,
    });
    expect(state.deleted).toContain('doc-1');
  });

  it('docs.usages returns incoming skill refs', async () => {
    const { registry } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    const res = await registry.dispatch({
      name: 'docs.usages',
      input: { id: 'doc-1' },
      ctx,
    });
    const text = (res.result.content[0] as { text: string }).text;
    expect(text).toContain('skill-1');
  });

  it('docs.attach_to requires approval', async () => {
    const { registry } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    await expect(
      registry.dispatch({
        name: 'docs.attach_to',
        input: { doc_id: 'doc-1', skill_ids: ['skill-1'] },
        ctx,
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('docs.update_summary forwards reEmbed flag', async () => {
    const { registry, state } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    await registry.dispatch({
      name: 'docs.update_summary',
      input: { id: 'doc-1', summary: 'new summary', re_embed: false },
      ctx,
      bypassApproval: true,
    });
    const last = state.updates.at(-1)?.patch as { description?: string; reEmbed?: boolean };
    expect(last?.description).toBe('new summary');
    expect(last?.reEmbed).toBe(false);
  });

  it('docs.put validates required fields', async () => {
    const { registry } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    await expect(
      registry.dispatch({
        name: 'docs.put',
        input: { body: 'no filename' } as unknown,
        ctx,
        bypassApproval: true,
      }),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// skills.* tools
// ===========================================================================

describe('skills tools', () => {
  it('skills.put requires approval', async () => {
    const { registry } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    await expect(
      registry.dispatch({
        name: 'skills.put',
        input: { title: 'New Skill', manifest: '# Skill\n' },
        ctx,
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('skills.put creates with bypass', async () => {
    const { registry, state } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    await registry.dispatch({
      name: 'skills.put',
      input: {
        title: 'New Skill',
        manifest: '# Skill\n',
        groups: ['core'],
        resource_ids: ['doc-1'],
      },
      ctx,
      bypassApproval: true,
    });
    const created = state.objects.get('new-skill');
    expect(created?.subtype).toBe('skill_manifest');
    expect(created?.meta?.['groups']).toEqual(['core']);
    expect(created?.meta?.['resource_ids']).toEqual(['doc-1']);
  });

  it('skills.get reads a skill', async () => {
    const { registry } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    const res = await registry.dispatch({
      name: 'skills.get',
      input: { id: 'skill-1' },
      ctx,
    });
    const text = (res.result.content[0] as { text: string }).text;
    expect(text).toContain('skill-1');
  });

  it('skills.list returns skills', async () => {
    const { registry } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    const res = await registry.dispatch({
      name: 'skills.list',
      input: {},
      ctx,
    });
    const text = (res.result.content[0] as { text: string }).text;
    expect(text).toContain('skill-1');
  });

  it('skills.search restricts kinds=["skill"]', async () => {
    const { registry } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    const res = await registry.dispatch({
      name: 'skills.search',
      input: { query: 'x' },
      ctx,
    });
    const text = (res.result.content[0] as { text: string }).text;
    expect(text).toContain('skill-1');
    expect(text).not.toContain('memo-1');
  });

  it('skills.delete without force fails on refcount>0', async () => {
    const { registry, state } = buildRegistry();
    state.objects.set('skill-1', makeSkill({ refcount: 1 }));
    const ctx = makeCtx(makeAudit());
    await expect(
      registry.dispatch({
        name: 'skills.delete',
        input: { id: 'skill-1' },
        ctx,
        bypassApproval: true,
      }),
    ).rejects.toThrow(/still referenced/);
  });

  it('skills.read_resource forwards to KnowledgeService', async () => {
    const { registry } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    const res = await registry.dispatch({
      name: 'skills.read_resource',
      input: { skill_id: 'skill-1', resource_id: 'doc-1' },
      ctx,
    });
    const text = (res.result.content[0] as { text: string }).text;
    expect(text).toContain('doc-1');
  });

  it('skills.attach_resource requires approval', async () => {
    const { registry } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    await expect(
      registry.dispatch({
        name: 'skills.attach_resource',
        input: { skill_id: 'skill-1', doc_id: 'doc-1' },
        ctx,
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });
});

// ===========================================================================
// memorize.* tools
// ===========================================================================

describe('memorize tools', () => {
  it('memorize.add requires approval', async () => {
    const { registry } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    await expect(
      registry.dispatch({
        name: 'memorize.add',
        input: { text: 'I like blue', scope: 'preferences' },
        ctx,
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('memorize.add creates with subtype=memo + meta.scope + embed', async () => {
    const { registry, state } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    await registry.dispatch({
      name: 'memorize.add',
      input: { text: 'I like blue', scope: 'preferences' },
      ctx,
      bypassApproval: true,
    });
    const created = state.objects.get('new-memo');
    expect(created?.subtype).toBe('memo');
    expect((created?.meta as { scope?: string } | null | undefined)?.scope).toBe('preferences');
  });

  it('memorize.search restricts subtypes=["memo"] + scope filter', async () => {
    const { registry } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    const res = await registry.dispatch({
      name: 'memorize.search',
      input: { query: 'x', scope: 'project' },
      ctx,
    });
    const text = (res.result.content[0] as { text: string }).text;
    expect(text).toContain('memo-1');
    expect(text).not.toContain('skill-1');
  });

  it('memorize.list_recent filters by scope', async () => {
    const { registry } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    const res = await registry.dispatch({
      name: 'memorize.list_recent',
      input: { scope: 'preferences', limit: 50 },
      ctx,
    });
    expect(res.sensitivity).toBe('read');
  });

  it('memorize.delete is danger + requires approval', async () => {
    const { registry } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    await expect(
      registry.dispatch({
        name: 'memorize.delete',
        input: { id: 'memo-1' },
        ctx,
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });
});

// ===========================================================================
// objects.* tools
// ===========================================================================

describe('objects tools', () => {
  it('objects.list returns all kinds', async () => {
    const { registry } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    const res = await registry.dispatch({
      name: 'objects.list',
      input: {},
      ctx,
    });
    const text = (res.result.content[0] as { text: string }).text;
    expect(text).toContain('doc-1');
    expect(text).toContain('skill-1');
  });

  it('objects.list filters by subtype', async () => {
    const { registry } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    const res = await registry.dispatch({
      name: 'objects.list',
      input: { subtype: 'skill_manifest' },
      ctx,
    });
    const text = (res.result.content[0] as { text: string }).text;
    expect(text).toContain('skill-1');
    expect(text).not.toContain('"subtype":"doc"');
  });

  it('objects.read reads by id', async () => {
    const { registry } = buildRegistry();
    const ctx = makeCtx(makeAudit());
    const res = await registry.dispatch({
      name: 'objects.read',
      input: { id: 'doc-1' },
      ctx,
    });
    const text = (res.result.content[0] as { text: string }).text;
    expect(text).toContain('doc-1');
  });
});
