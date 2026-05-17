/**
 * Bookmarks-Tools — Smoke-Tests.
 *
 * Plan-Ref: docs/plans/active/PLAN-wrapper-conventions.md §"Body-Formate / bookmark".
 *
 * Cover:
 *   - create: subtype='bookmark' + meta.url
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
  makeBookmarksCreateTool,
  makeBookmarksDeleteTool,
  makeBookmarksGetTool,
  makeBookmarksListTool,
} from './bookmarks-tools.js';

const USER_ID = '00000000-0000-0000-0000-000000000001';

function makeAudit(): AuditService {
  return { async emit() {} };
}

function makeBookmarkObj(overrides: Partial<KnowledgeObject> = {}): KnowledgeObject {
  return {
    id: 'bm-1',
    ownerId: USER_ID,
    subtype: 'bookmark',
    title: 'Example',
    description: null,
    keywords: [],
    triggerHints: null,
    meta: { url: 'https://example.com' },
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
    deleted: string[];
  };
} {
  const objects = new Map<string, KnowledgeObject>();
  const creates: unknown[] = [];
  const deleted: string[] = [];
  objects.set('bm-1', makeBookmarkObj());
  const adapter: KnowledgeAdapter = {
    async createObject(args) {
      creates.push(args);
      const obj = makeBookmarkObj({
        id: 'new-bm',
        subtype: args.subtype ?? 'bookmark',
        title: args.title ?? null,
        meta: args.meta ?? null,
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
  return { adapter, state: { objects, creates, deleted } };
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
  registry.register(makeBookmarksCreateTool({ knowledge }));
  registry.register(makeBookmarksListTool({ knowledge }));
  registry.register(makeBookmarksGetTool({ knowledge }));
  registry.register(makeBookmarksDeleteTool({ knowledge }));
  return { registry, state };
}

describe('bookmarks.create', () => {
  it('requires approval', async () => {
    const { registry } = build();
    await expect(
      registry.dispatch({
        name: 'bookmarks.create',
        input: { title: 'X', url: 'https://example.com' },
        ctx: makeCtx(),
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('creates with subtype=bookmark and meta.url', async () => {
    const { registry, state } = build();
    await registry.dispatch({
      name: 'bookmarks.create',
      input: { title: 'Anthropic', url: 'https://www.anthropic.com', notes: 'Reference' },
      ctx: makeCtx(),
      bypassApproval: true,
    });
    expect(state.creates.length).toBe(1);
    const args = state.creates[0] as { subtype?: string; meta?: { url?: string }; body?: string };
    expect(args.subtype).toBe('bookmark');
    expect(args.meta?.url).toBe('https://www.anthropic.com');
    expect(args.body).toBe('Reference');
  });

  it('rejects bad URL', async () => {
    const { registry } = build();
    await expect(
      registry.dispatch({
        name: 'bookmarks.create',
        input: { title: 'X', url: 'not-a-url' },
        ctx: makeCtx(),
        bypassApproval: true,
      }),
    ).rejects.toThrow();
  });
});

describe('bookmarks read tools', () => {
  it('bookmarks.list returns bookmarks', async () => {
    const { registry } = build();
    const res = await registry.dispatch({
      name: 'bookmarks.list',
      input: {},
      ctx: makeCtx(),
    });
    expect(res.sensitivity).toBe('read');
    const text = (res.result.content[0] as { text: string }).text;
    expect(text).toContain('bm-1');
  });

  it('bookmarks.get fetches one', async () => {
    const { registry } = build();
    const res = await registry.dispatch({
      name: 'bookmarks.get',
      input: { id: 'bm-1' },
      ctx: makeCtx(),
    });
    expect(res.sensitivity).toBe('read');
  });
});

describe('bookmarks.delete', () => {
  it('requires approval (danger)', async () => {
    const { registry } = build();
    await expect(
      registry.dispatch({
        name: 'bookmarks.delete',
        input: { id: 'bm-1' },
        ctx: makeCtx(),
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('deletes with bypass', async () => {
    const { registry, state } = build();
    await registry.dispatch({
      name: 'bookmarks.delete',
      input: { id: 'bm-1' },
      ctx: makeCtx(),
      bypassApproval: true,
    });
    expect(state.deleted).toContain('bm-1');
  });
});
