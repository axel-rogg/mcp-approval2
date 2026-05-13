/**
 * AppsService unit-Tests gegen einen In-Memory-KnowledgeAdapter.
 *
 * Test-Coverage:
 *   - createApp / readApp / listApps / deleteApp Roundtrip
 *   - updateState mit CAS-Conflict
 *   - invoke (composable + block-action-dispatch)
 *   - query (read-only)
 *   - updateLayout (full LayoutDoc replace)
 *   - SINGLE_INSTANCE-Guard (n/a heute — composable nicht single_instance)
 *   - Multi-User-Isolation (User-A kann nicht User-B's app lesen)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  CreateObjectArgs,
  GetObjectArgs,
  KnowledgeAdapter,
  KnowledgeObject,
  ListObjectsArgs,
  ObjectKind,
  ObjectsList,
  RevokeShareArgs,
  Share,
  SearchHit,
  SearchArgs,
  UpdateObjectArgs,
  CreateShareArgs,
  EraseUserArgs,
  EraseUserResult,
  ListSharesArgs,
} from '@mcp-approval2/adapters';
import { KnowledgeService } from '../services/knowledge.js';
import { createAppsService, AppsServiceError } from './api.js';
import type { LayoutDoc } from './blocks/types.js';

// ---------------------------------------------------------------------------
// In-Memory KnowledgeAdapter
// ---------------------------------------------------------------------------

function bytesFromBody(body: Uint8Array | string | undefined): Uint8Array {
  if (body == null) return new Uint8Array(0);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  return body;
}

function bytesToB64(b: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(b).toString('base64');
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] ?? 0);
  return btoa(s);
}

class InMemoryKnowledgeAdapter implements KnowledgeAdapter {
  private idCounter = 0;
  // ownerId -> id -> {meta, bodyBytes}
  private store = new Map<string, Map<string, { obj: KnowledgeObject; body: Uint8Array }>>();

  private nextId(): string {
    this.idCounter += 1;
    return `app-${this.idCounter.toString().padStart(6, '0')}`;
  }

  private bucket(userId: string): Map<string, { obj: KnowledgeObject; body: Uint8Array }> {
    let b = this.store.get(userId);
    if (!b) {
      b = new Map();
      this.store.set(userId, b);
    }
    return b;
  }

  async createObject(args: CreateObjectArgs): Promise<KnowledgeObject> {
    const id = this.nextId();
    const now = Date.now();
    const bodyBytes = bytesFromBody(args.body);
    const obj: KnowledgeObject = {
      id,
      ownerId: args.userId,
      kind: args.kind,
      subtype: args.subtype ?? null,
      title: args.title ?? null,
      description: args.description ?? null,
      keywords: args.keywords ?? null,
      triggerHints: args.triggerHints ?? null,
      meta: args.meta ?? null,
      bodySize: bodyBytes.length,
      bodyHash: null,
      mimeType: args.mimeType ?? null,
      filename: args.filename ?? null,
      visibility: args.visibility ?? 'private',
      pinned: false,
      archived: false,
      refcount: 0,
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    };
    this.bucket(args.userId).set(id, { obj, body: bodyBytes });
    return obj;
  }

  async getObject(args: GetObjectArgs): Promise<KnowledgeObject> {
    const entry = this.bucket(args.userId).get(args.id);
    if (!entry) throw new Error(`404 not found: ${args.id}`);
    if (args.expandBody) {
      return { ...entry.obj, body: bytesToB64(entry.body) };
    }
    return entry.obj;
  }

  async listObjects(args: ListObjectsArgs): Promise<ObjectsList> {
    const bucket = this.bucket(args.userId);
    let items: KnowledgeObject[] = [...bucket.values()].map((v) => v.obj);
    if (args.kind) items = items.filter((o) => o.kind === args.kind);
    if (args.subtype) items = items.filter((o) => o.subtype === args.subtype);
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    const limit = args.limit ?? items.length;
    return { items: items.slice(0, limit), nextCursor: null };
  }

  async updateObject(args: UpdateObjectArgs): Promise<KnowledgeObject> {
    const entry = this.bucket(args.userId).get(args.id);
    if (!entry) throw new Error(`404 not found: ${args.id}`);
    if (
      args.patch.expectedVersion !== undefined &&
      args.patch.expectedVersion !== entry.obj.currentVersion
    ) {
      const err = new Error(
        `409 cas_conflict: expected ${args.patch.expectedVersion}, current ${entry.obj.currentVersion}`,
      );
      throw err;
    }
    const newBody = args.patch.body !== undefined ? bytesFromBody(args.patch.body) : entry.body;
    const obj: KnowledgeObject = {
      ...entry.obj,
      title: args.patch.title !== undefined ? (args.patch.title ?? null) : entry.obj.title,
      description:
        args.patch.description !== undefined ? (args.patch.description ?? null) : entry.obj.description,
      keywords:
        args.patch.keywords !== undefined ? (args.patch.keywords ?? null) : entry.obj.keywords,
      triggerHints:
        args.patch.triggerHints !== undefined ? (args.patch.triggerHints ?? null) : entry.obj.triggerHints,
      meta: args.patch.meta !== undefined ? (args.patch.meta ?? null) : entry.obj.meta,
      bodySize: newBody.length,
      pinned: args.patch.pinned !== undefined ? args.patch.pinned : entry.obj.pinned,
      archived: args.patch.archived !== undefined ? args.patch.archived : entry.obj.archived,
      currentVersion: entry.obj.currentVersion + 1,
      updatedAt: Date.now(),
    };
    this.bucket(args.userId).set(args.id, { obj, body: newBody });
    return obj;
  }

  async deleteObject(args: { id: string; userId: string }): Promise<void> {
    const bucket = this.bucket(args.userId);
    if (!bucket.has(args.id)) throw new Error(`404 not found: ${args.id}`);
    bucket.delete(args.id);
  }

  async createShare(_args: CreateShareArgs): Promise<Share> {
    throw new Error('share not implemented in stub');
  }
  async listShares(_args: ListSharesArgs): Promise<ReadonlyArray<Share>> {
    return [];
  }
  async revokeShare(_args: RevokeShareArgs): Promise<void> {
    /* no-op */
  }
  async search(_args: SearchArgs): Promise<ReadonlyArray<SearchHit>> {
    return [];
  }
  async eraseUser(_args: EraseUserArgs): Promise<EraseUserResult> {
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
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const USER_A = '00000000-0000-0000-0000-000000000001';
const USER_B = '00000000-0000-0000-0000-000000000002';

function makeAudit(): { audit: { emit: (e: unknown) => Promise<void> }; events: unknown[] } {
  const events: unknown[] = [];
  return {
    audit: {
      emit: async (e) => {
        events.push(e);
      },
    },
    events,
  };
}

function makeService() {
  const adapter = new InMemoryKnowledgeAdapter();
  const audit = makeAudit();
  const knowledge = new KnowledgeService({ adapter, audit: audit.audit });
  const apps = createAppsService({ knowledge, audit: audit.audit });
  return { adapter, knowledge, apps, audit };
}

const emptyLayout: LayoutDoc = { version: 'v0.10', components: [], state: {} };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AppsService — create + read', () => {
  let svc: ReturnType<typeof makeService>;
  beforeEach(() => {
    svc = makeService();
  });

  it('creates a composable app with default layout', async () => {
    const inst = await svc.apps.createApp({
      userId: USER_A,
      appType: 'composable',
      title: 'My App',
    });
    expect(inst.id).toMatch(/^app-/);
    expect(inst.userId).toBe(USER_A);
    expect(inst.type).toBe('composable');
    expect(inst.title).toBe('My App');
    expect(inst.state_version).toBe(1);
    expect(inst.schema_version).toBe(1);
  });

  it('readApp returns state matching the initial layout', async () => {
    const inst = await svc.apps.createApp({
      userId: USER_A,
      appType: 'composable',
      title: 'X',
    });
    const read = await svc.apps.readApp<LayoutDoc>({ userId: USER_A, id: inst.id });
    expect(read.app.id).toBe(inst.id);
    expect(read.state.version).toBe('v0.10');
    expect(read.state.components).toEqual([]);
  });

  it('rejects unknown app type', async () => {
    await expect(
      svc.apps.createApp({ userId: USER_A, appType: 'no-such-type' }),
    ).rejects.toThrowError(/Unknown app type/);
  });

  it('rejects invalid initial state', async () => {
    await expect(
      svc.apps.createApp({
        userId: USER_A,
        appType: 'composable',
        initialState: { version: 'v0.99', components: [], state: {} },
      }),
    ).rejects.toThrowError(/v0\.10/);
  });
});

describe('AppsService — list + delete', () => {
  it('listApps returns only the requesting user\'s apps', async () => {
    const svc = makeService();
    await svc.apps.createApp({ userId: USER_A, appType: 'composable', title: 'A1' });
    await svc.apps.createApp({ userId: USER_A, appType: 'composable', title: 'A2' });
    await svc.apps.createApp({ userId: USER_B, appType: 'composable', title: 'B1' });
    const listA = await svc.apps.listApps({ userId: USER_A });
    const listB = await svc.apps.listApps({ userId: USER_B });
    expect(listA).toHaveLength(2);
    expect(listB).toHaveLength(1);
    expect(listA.map((a) => a.title).sort()).toEqual(['A1', 'A2']);
    expect(listB[0]!.title).toBe('B1');
  });

  it('deleteApp removes the instance', async () => {
    const svc = makeService();
    const inst = await svc.apps.createApp({ userId: USER_A, appType: 'composable' });
    await svc.apps.deleteApp({ userId: USER_A, id: inst.id });
    const list = await svc.apps.listApps({ userId: USER_A });
    expect(list).toHaveLength(0);
  });

  it('User-B cannot read User-A\'s app', async () => {
    const svc = makeService();
    const inst = await svc.apps.createApp({ userId: USER_A, appType: 'composable' });
    await expect(svc.apps.readApp({ userId: USER_B, id: inst.id })).rejects.toThrowError(
      /not found/i,
    );
  });
});

describe('AppsService — updateState + CAS', () => {
  it('CAS-conflict throws CONCURRENT_UPDATE with retriable=true', async () => {
    const svc = makeService();
    const inst = await svc.apps.createApp({ userId: USER_A, appType: 'composable' });
    await expect(
      svc.apps.updateState({
        userId: USER_A,
        id: inst.id,
        statePatch: emptyLayout,
        expectedVersion: 99,
      }),
    ).rejects.toMatchObject({ code: 'CONCURRENT_UPDATE', retriable: true });
  });

  it('updateState bumps state_version', async () => {
    const svc = makeService();
    const inst = await svc.apps.createApp({ userId: USER_A, appType: 'composable' });
    const next: LayoutDoc = {
      version: 'v0.10',
      components: [{ id: 'c1', block: 'counter' }],
      state: { c1: { value: 5, target: null, lastReset: null } },
    };
    const updated = await svc.apps.updateState({
      userId: USER_A,
      id: inst.id,
      statePatch: next,
      expectedVersion: 1,
    });
    expect(updated.state_version).toBe(2);
  });
});

describe('AppsService — invoke (composable + counter)', () => {
  it('invokes counter.increment and persists', async () => {
    const svc = makeService();
    const layout: LayoutDoc = {
      version: 'v0.10',
      components: [{ id: 'c1', block: 'counter' }],
      state: { c1: { value: 10, target: null, lastReset: null } },
    };
    const inst = await svc.apps.createApp({
      userId: USER_A,
      appType: 'composable',
      initialState: layout,
    });
    const r = await svc.apps.invoke({
      userId: USER_A,
      id: inst.id,
      block_id: 'c1',
      action: 'increment',
      payload: { by: 3 },
    });
    expect(r.new_version).toBe(2);
    const read = await svc.apps.readApp<LayoutDoc>({ userId: USER_A, id: inst.id });
    expect((read.state.state as Record<string, { value: number }>)['c1']!.value).toBe(13);
  });

  it('rejects unknown block_id', async () => {
    const svc = makeService();
    const inst = await svc.apps.createApp({
      userId: USER_A,
      appType: 'composable',
      initialState: { version: 'v0.10', components: [], state: {} },
    });
    await expect(
      svc.apps.invoke({
        userId: USER_A,
        id: inst.id,
        block_id: 'doesnt-exist',
        action: 'increment',
        payload: {},
      }),
    ).rejects.toThrowError(/not in layout/);
  });
});

describe('AppsService — query', () => {
  it('returns the computed value', async () => {
    const svc = makeService();
    const layout: LayoutDoc = {
      version: 'v0.10',
      components: [{ id: 'c1', block: 'counter' }],
      state: { c1: { value: 42, target: 100, lastReset: null } },
    };
    const inst = await svc.apps.createApp({
      userId: USER_A,
      appType: 'composable',
      initialState: layout,
    });
    const v = await svc.apps.query({
      userId: USER_A,
      id: inst.id,
      block_id: 'c1',
      query: 'value',
    });
    expect(v).toBe(42);
    const ratio = await svc.apps.query({
      userId: USER_A,
      id: inst.id,
      block_id: 'c1',
      query: 'progressRatio',
    });
    expect(ratio).toBeCloseTo(0.42);
  });
});

describe('AppsService — updateLayout', () => {
  it('replaces layoutDoc and bumps version', async () => {
    const svc = makeService();
    const inst = await svc.apps.createApp({ userId: USER_A, appType: 'composable' });
    const next: LayoutDoc = {
      version: 'v0.10',
      components: [
        { id: 'hdr', block: 'text_field', config: {} },
        { id: 'lst', block: 'list', config: {} },
      ],
      state: {
        hdr: { value: 'Hello', placeholder: null, multiline: false, maxLength: null },
        lst: { items: [] },
      },
    };
    const updated = await svc.apps.updateLayout({
      userId: USER_A,
      id: inst.id,
      layoutDoc: next,
      expectedVersion: 1,
    });
    expect(updated.state_version).toBe(2);
  });
});

describe('AppsService — errors', () => {
  it('throws AppsServiceError instances', async () => {
    const svc = makeService();
    try {
      await svc.apps.readApp({ userId: USER_A, id: 'nonexistent' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppsServiceError);
    }
  });
});
