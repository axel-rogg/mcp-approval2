/**
 * Notes-Tools — Smoke-Tests.
 *
 * Plan-Ref: docs/plans/active/PLAN-wrapper-conventions.md §"Body-Formate / note".
 *
 * Cover:
 *   - create: dispatcht createObject mit subtype='note'
 *   - update: forwards patch fields
 *   - list/get: read-Path
 *   - delete: danger — requires approval
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
  makeNotesCreateTool,
  makeNotesDeleteTool,
  makeNotesGetTool,
  makeNotesListTool,
  makeNotesUpdateTool,
} from './notes-tools.js';

const USER_ID = '00000000-0000-0000-0000-000000000001';

function makeAudit(): AuditService {
  return { async emit() {} };
}

function makeNoteObj(overrides: Partial<KnowledgeObject> = {}): KnowledgeObject {
  return {
    id: 'note-1',
    ownerId: USER_ID,
    subtype: 'note',
    title: 'Sample',
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
  objects.set('note-1', makeNoteObj({ body: '# Sample\n\nNotes...' }));
  const adapter: KnowledgeAdapter = {
    async createObject(args) {
      creates.push(args);
      const obj = makeNoteObj({
        id: 'new-note',
        subtype: args.subtype ?? 'note',
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
  registry.register(makeNotesCreateTool({ knowledge }));
  registry.register(makeNotesUpdateTool({ knowledge }));
  registry.register(makeNotesListTool({ knowledge }));
  registry.register(makeNotesGetTool({ knowledge }));
  registry.register(makeNotesDeleteTool({ knowledge }));
  return { registry, state };
}

describe('notes.create', () => {
  it('requires approval', async () => {
    const { registry } = build();
    await expect(
      registry.dispatch({
        name: 'notes.create',
        input: { title: 'X', body: '# X\n\nhi' },
        ctx: makeCtx(),
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('creates with subtype=note', async () => {
    const { registry, state } = build();
    await registry.dispatch({
      name: 'notes.create',
      input: { title: 'X', body: '# X\n\nhi', embed: true, description: 'short' },
      ctx: makeCtx(),
      bypassApproval: true,
    });
    expect(state.creates.length).toBe(1);
    const args = state.creates[0] as { subtype?: string; embed?: boolean; description?: string };
    expect(args.subtype).toBe('note');
    expect(args.embed).toBe(true);
    expect(args.description).toBe('short');
  });
});

describe('notes.update', () => {
  it('requires approval', async () => {
    const { registry } = build();
    await expect(
      registry.dispatch({
        name: 'notes.update',
        input: { id: 'note-1', body: 'new body' },
        ctx: makeCtx(),
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('forwards patch fields', async () => {
    const { registry, state } = build();
    await registry.dispatch({
      name: 'notes.update',
      input: { id: 'note-1', title: 'New Title', body: 'new body' },
      ctx: makeCtx(),
      bypassApproval: true,
    });
    expect(state.updates.length).toBe(1);
    const patch = state.updates[0]!.patch;
    expect(patch['title']).toBe('New Title');
    expect(patch['body']).toBe('new body');
  });

  it('rejects empty patch (zod refine)', async () => {
    const { registry } = build();
    await expect(
      registry.dispatch({
        name: 'notes.update',
        input: { id: 'note-1' },
        ctx: makeCtx(),
        bypassApproval: true,
      }),
    ).rejects.toThrow();
  });
});

describe('notes read tools', () => {
  it('notes.list returns notes', async () => {
    const { registry } = build();
    const res = await registry.dispatch({
      name: 'notes.list',
      input: {},
      ctx: makeCtx(),
    });
    expect(res.sensitivity).toBe('read');
  });

  it('notes.get reads by id', async () => {
    const { registry } = build();
    const res = await registry.dispatch({
      name: 'notes.get',
      input: { id: 'note-1' },
      ctx: makeCtx(),
    });
    expect(res.sensitivity).toBe('read');
    const text = (res.result.content[0] as { text: string }).text;
    expect(text).toContain('note-1');
  });
});

describe('notes.delete', () => {
  it('requires approval (danger)', async () => {
    const { registry } = build();
    await expect(
      registry.dispatch({
        name: 'notes.delete',
        input: { id: 'note-1' },
        ctx: makeCtx(),
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('deletes with bypass', async () => {
    const { registry, state } = build();
    await registry.dispatch({
      name: 'notes.delete',
      input: { id: 'note-1' },
      ctx: makeCtx(),
      bypassApproval: true,
    });
    expect(state.deleted).toContain('note-1');
  });
});
