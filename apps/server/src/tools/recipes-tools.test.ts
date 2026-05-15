/**
 * Recipes-Tools — Smoke-Tests.
 *
 * Plan-Ref: docs/plans/active/PLAN-wrapper-conventions.md §"Body-Formate / recipe".
 *
 * Cover:
 *   - frontmatter validator: shape-check, optional
 *   - create: subtype='recipe'
 *   - update: forwards patch
 *   - list/get: read
 *   - delete: danger
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
  makeRecipesCreateTool,
  makeRecipesDeleteTool,
  makeRecipesGetTool,
  makeRecipesListTool,
  makeRecipesUpdateTool,
  validateRecipeFrontmatter,
} from './recipes-tools.js';

const USER_ID = '00000000-0000-0000-0000-000000000001';

function makeAudit(): AuditService {
  return { async emit() {} };
}

function makeRecipeObj(overrides: Partial<KnowledgeObject> = {}): KnowledgeObject {
  return {
    id: 'recipe-1',
    ownerId: USER_ID,
    subtype: 'recipe',
    title: 'Pasta',
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

function makeAdapter(): {
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
  objects.set('recipe-1', makeRecipeObj({ body: '# Pasta\n\n- 200g Mehl' }));
  const adapter: KnowledgeAdapter = {
    async createObject(args) {
      creates.push(args);
      const obj = makeRecipeObj({
        id: 'new-recipe',
        subtype: args.subtype ?? 'recipe',
        title: args.title ?? null,
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
      updates.push({ id: args.id, patch: args.patch as Record<string, unknown> });
      const cur = objects.get(args.id);
      if (!cur) throw new Error(`not found: ${args.id}`);
      return cur;
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
    async revokeShare() {},
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

function build(): {
  registry: ToolRegistry;
  state: ReturnType<typeof makeAdapter>['state'];
} {
  const audit = makeAudit();
  const { adapter, state } = makeAdapter();
  const knowledge = new KnowledgeService({ adapter, audit });
  const registry = new ToolRegistry();
  registry.register(makeRecipesCreateTool({ knowledge }));
  registry.register(makeRecipesUpdateTool({ knowledge }));
  registry.register(makeRecipesListTool({ knowledge }));
  registry.register(makeRecipesGetTool({ knowledge }));
  registry.register(makeRecipesDeleteTool({ knowledge }));
  return { registry, state };
}

describe('validateRecipeFrontmatter', () => {
  it('accepts body without frontmatter', () => {
    expect(() => validateRecipeFrontmatter('# Pasta\n\nSteps...')).not.toThrow();
  });

  it('accepts valid YAML frontmatter', () => {
    expect(() =>
      validateRecipeFrontmatter('---\nservings: 4\nprep_time: 20\n---\n\n# Pasta'),
    ).not.toThrow();
  });

  it('rejects malformed frontmatter (no closing ---)', () => {
    expect(() => validateRecipeFrontmatter('---\nservings: 4\n\n# Pasta')).toThrow(
      /malformed YAML frontmatter/,
    );
  });
});

describe('recipes.create', () => {
  it('requires approval', async () => {
    const { registry } = build();
    await expect(
      registry.dispatch({
        name: 'recipes.create',
        input: { title: 'Pasta', body: '# Pasta\n' },
        ctx: makeCtx(),
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('creates with subtype=recipe', async () => {
    const { registry, state } = build();
    await registry.dispatch({
      name: 'recipes.create',
      input: {
        title: 'Pasta Carbonara',
        body: '---\nservings: 4\n---\n\n# Pasta\n\n## Zutaten\n- 200g Mehl',
        keywords: ['italian'],
      },
      ctx: makeCtx(),
      bypassApproval: true,
    });
    const args = state.creates[0] as { subtype?: string; keywords?: ReadonlyArray<string> };
    expect(args.subtype).toBe('recipe');
    expect(args.keywords).toEqual(['italian']);
  });

  it('rejects malformed frontmatter at create-time', async () => {
    const { registry } = build();
    await expect(
      registry.dispatch({
        name: 'recipes.create',
        input: { title: 'Bad', body: '---\nservings: 4\n\n# Pasta' },
        ctx: makeCtx(),
        bypassApproval: true,
      }),
    ).rejects.toThrow(/malformed YAML frontmatter/);
  });
});

describe('recipes.update', () => {
  it('requires approval', async () => {
    const { registry } = build();
    await expect(
      registry.dispatch({
        name: 'recipes.update',
        input: { id: 'recipe-1', body: 'new' },
        ctx: makeCtx(),
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('forwards patch fields', async () => {
    const { registry, state } = build();
    await registry.dispatch({
      name: 'recipes.update',
      input: { id: 'recipe-1', title: 'Pasta Bolognese' },
      ctx: makeCtx(),
      bypassApproval: true,
    });
    expect(state.updates[0]!.patch['title']).toBe('Pasta Bolognese');
  });
});

describe('recipes read tools', () => {
  it('recipes.list returns recipes', async () => {
    const { registry } = build();
    const res = await registry.dispatch({
      name: 'recipes.list',
      input: {},
      ctx: makeCtx(),
    });
    expect(res.sensitivity).toBe('read');
  });

  it('recipes.get fetches one', async () => {
    const { registry } = build();
    const res = await registry.dispatch({
      name: 'recipes.get',
      input: { id: 'recipe-1' },
      ctx: makeCtx(),
    });
    const text = (res.result.content[0] as { text: string }).text;
    expect(text).toContain('recipe-1');
  });
});

describe('recipes.delete', () => {
  it('requires approval (danger)', async () => {
    const { registry } = build();
    await expect(
      registry.dispatch({
        name: 'recipes.delete',
        input: { id: 'recipe-1' },
        ctx: makeCtx(),
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('deletes with bypass', async () => {
    const { registry, state } = build();
    await registry.dispatch({
      name: 'recipes.delete',
      input: { id: 'recipe-1' },
      ctx: makeCtx(),
      bypassApproval: true,
    });
    expect(state.deleted).toContain('recipe-1');
  });
});
