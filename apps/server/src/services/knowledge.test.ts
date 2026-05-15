/**
 * KnowledgeService tests — Audit-Log-Emission + Adapter-Pass-Through.
 *
 * Wir mocken den KnowledgeAdapter komplett (in-memory Stub) und prueffen:
 *   1. createObject ruft Adapter + emit Audit (success)
 *   2. getObject + listObjects + updateObject + deleteObject emitten korrekt
 *   3. Bei Adapter-Throw: audit failure, exception bubbles
 *   4. eraseUser nimmt actorUserId separat von targetUserId
 *   5. RequestId wird durchgereicht wenn requestIdProvider gesetzt
 */
import { describe, it, expect, vi } from 'vitest';
import type { KnowledgeAdapter, KnowledgeObject, ObjectsList, Share, SearchHit } from '@mcp-approval2/adapters';
import { KnowledgeService, type AuditService } from './knowledge.js';
import { NotFoundError } from '@mcp-approval2/adapters/knowledge/errors';

const USER_ID = '00000000-0000-0000-0000-000000000001';

function makeAdapterStub(): { adapter: KnowledgeAdapter; calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {};
  function record(name: string, args: unknown[]): void {
    calls[name] ??= [];
    calls[name].push(args);
  }
  const obj: KnowledgeObject = {
    id: 'obj-1',
    ownerId: USER_ID,
    subtype: 'file',
    title: 't',
    description: 'd',
    keywords: [],
    triggerHints: null,
    meta: null,
    bodySize: 4,
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
  };
  const list: ObjectsList = { items: [obj], nextCursor: null };
  const share: Share = {
    id: 'share-1',
    resourceId: 'obj-1',
    grantedBy: USER_ID,
    grantedTo: 'user-2',
    scope: 'read',
    grantedAt: 1,
    expiresAt: null,
    revokedAt: null,
  };
  const hits: ReadonlyArray<SearchHit> = [
    { id: 'obj-1', subtype: 'file', title: 't', score: 0.9, ftsRank: 0.5, vectorScore: 0.4 },
  ];

  const adapter: KnowledgeAdapter = {
    async createObject(args) {
      record('createObject', [args]);
      return obj;
    },
    async getObject(args) {
      record('getObject', [args]);
      return obj;
    },
    async listObjects(args) {
      record('listObjects', [args]);
      return list;
    },
    async updateObject(args) {
      record('updateObject', [args]);
      return obj;
    },
    async deleteObject(args) {
      record('deleteObject', [args]);
    },
    async createShare(args) {
      record('createShare', [args]);
      return share;
    },
    async listShares(args) {
      record('listShares', [args]);
      return [share];
    },
    async revokeShare(args) {
      record('revokeShare', [args]);
    },
    async search(args) {
      record('search', [args]);
      return hits;
    },
    async eraseUser(args) {
      record('eraseUser', [args]);
      return {
        status: 'ok',
        deleted: {
          objects: 42,
          shares: 0,
          idempotency: 0,
          uploads: 0,
          auditPseudonymised: 0,
          blobsDeleted: 42,
          blobsPending: 0,
        },
        deletedRows: 42,
      };
    },
    async syncUser(args) {
      record('syncUser', [args]);
      return { status: 'created', kcUserId: 'kc-user-1' };
    },
  };
  return { adapter, calls };
}

function makeAudit(): AuditService & { emitted: Array<Parameters<AuditService['emit']>[0]> } {
  const emitted: Array<Parameters<AuditService['emit']>[0]> = [];
  return {
    emitted,
    async emit(ev) {
      emitted.push(ev);
    },
  };
}

describe('KnowledgeService — success path', () => {
  it('createObject calls adapter + emits success audit', async () => {
    const { adapter, calls } = makeAdapterStub();
    const audit = makeAudit();
    const svc = new KnowledgeService({ adapter, audit });
    const out = await svc.createObject({ userId: USER_ID, subtype: 'file', title: 't' });
    expect(out.id).toBe('obj-1');
    expect(calls['createObject']).toHaveLength(1);
    expect(audit.emitted).toHaveLength(1);
    expect(audit.emitted[0]).toMatchObject({
      action: 'knowledge.file.created',
      actorUserId: USER_ID,
      result: 'success',
      resourceId: 'obj-1',
    });
  });

  it('getObject emits read audit', async () => {
    const { adapter } = makeAdapterStub();
    const audit = makeAudit();
    const svc = new KnowledgeService({ adapter, audit });
    await svc.getObject({ id: 'obj-1', userId: USER_ID });
    expect(audit.emitted[0]).toMatchObject({
      action: 'knowledge.object.read',
      actorUserId: USER_ID,
      result: 'success',
      resourceId: 'obj-1',
    });
  });

  it('listObjects records count + hasMore', async () => {
    const { adapter } = makeAdapterStub();
    const audit = makeAudit();
    const svc = new KnowledgeService({ adapter, audit });
    await svc.listObjects({ userId: USER_ID, subtype: 'skill_manifest', limit: 10 });
    expect(audit.emitted[0]).toMatchObject({
      action: 'knowledge.object.list',
      resourceKind: 'skill_manifest',
      result: 'success',
    });
    expect(audit.emitted[0]?.details).toMatchObject({ count: 1, hasMore: false });
  });

  it('updateObject records patched fields', async () => {
    const { adapter } = makeAdapterStub();
    const audit = makeAudit();
    const svc = new KnowledgeService({ adapter, audit });
    await svc.updateObject({ id: 'obj-1', userId: USER_ID, patch: { title: 'new', description: 'd2' } });
    expect(audit.emitted[0]?.details).toMatchObject({ patchedFields: ['title', 'description'] });
  });

  it('deleteObject emits success audit (no return value)', async () => {
    const { adapter, calls } = makeAdapterStub();
    const audit = makeAudit();
    const svc = new KnowledgeService({ adapter, audit });
    await svc.deleteObject({ id: 'obj-1', userId: USER_ID });
    expect(calls['deleteObject']).toHaveLength(1);
    expect(audit.emitted[0]).toMatchObject({
      action: 'knowledge.object.deleted',
      result: 'success',
      resourceId: 'obj-1',
    });
  });

  it('createShare records grantedTo+scope', async () => {
    const { adapter } = makeAdapterStub();
    const audit = makeAudit();
    const svc = new KnowledgeService({ adapter, audit });
    await svc.createShare({
      resourceId: 'obj-1',
      userId: USER_ID,
      grantedTo: 'user-2',
      scope: 'read',
    });
    expect(audit.emitted[0]).toMatchObject({
      action: 'knowledge.share.created',
      actorUserId: USER_ID,
      resourceId: 'obj-1',
      result: 'success',
    });
    expect(audit.emitted[0]?.details).toMatchObject({ grantedTo: 'user-2', scope: 'read', shareId: 'share-1' });
  });

  it('search records hit count + kinds', async () => {
    const { adapter } = makeAdapterStub();
    const audit = makeAudit();
    const svc = new KnowledgeService({ adapter, audit });
    await svc.search({ userId: USER_ID, query: 'foo bar', subtypes: ['file', 'skill_manifest'] });
    expect(audit.emitted[0]).toMatchObject({
      action: 'knowledge.search',
      result: 'success',
    });
    expect(audit.emitted[0]?.details).toMatchObject({
      count: 1,
      subtypes: ['file', 'skill_manifest'],
      queryLength: 7,
    });
  });
});

describe('KnowledgeService — failure path', () => {
  it('emits failure audit when adapter throws + rethrows', async () => {
    const { adapter } = makeAdapterStub();
    const audit = makeAudit();
    adapter.getObject = vi.fn().mockRejectedValue(new NotFoundError('no such doc'));
    const svc = new KnowledgeService({ adapter, audit });

    await expect(svc.getObject({ id: 'obj-x', userId: USER_ID })).rejects.toBeInstanceOf(NotFoundError);

    expect(audit.emitted).toHaveLength(1);
    expect(audit.emitted[0]).toMatchObject({
      action: 'knowledge.object.read',
      result: 'failure',
      resourceId: 'obj-x',
    });
    expect(audit.emitted[0]?.details).toMatchObject({ error: 'no such doc' });
  });
});

describe('KnowledgeService — eraseUser (admin)', () => {
  it('separates actor from target user in audit', async () => {
    const { adapter } = makeAdapterStub();
    const audit = makeAudit();
    const svc = new KnowledgeService({ adapter, audit });
    const result = await svc.eraseUser({
      userId: 'target-user',
      confirmationToken: 'tok-xyz',
      actorUserId: 'admin-user',
    });
    expect(result.deletedRows).toBe(42);
    expect(result.status).toBe('ok');
    expect(result.deleted.objects).toBe(42);
    expect(audit.emitted[0]).toMatchObject({
      action: 'knowledge.user.erased',
      actorUserId: 'admin-user',
      result: 'success',
    });
    expect(audit.emitted[0]?.details).toMatchObject({ targetUserId: 'target-user', deletedRows: 42 });
  });

  it('emits failure when erase fails', async () => {
    const { adapter } = makeAdapterStub();
    const audit = makeAudit();
    adapter.eraseUser = vi.fn().mockRejectedValue(new Error('confirmation token invalid'));
    const svc = new KnowledgeService({ adapter, audit });

    await expect(
      svc.eraseUser({ userId: 'target-user', confirmationToken: 'bad', actorUserId: 'admin' }),
    ).rejects.toThrow(/confirmation token invalid/);

    expect(audit.emitted[0]).toMatchObject({
      action: 'knowledge.user.erased',
      actorUserId: 'admin',
      result: 'failure',
    });
  });
});

describe('KnowledgeService — requestId propagation', () => {
  it('forwards requestId from provider into audit events', async () => {
    const { adapter } = makeAdapterStub();
    const audit = makeAudit();
    const svc = new KnowledgeService({
      adapter,
      audit,
      requestIdProvider: () => 'req-from-context-1',
    });
    await svc.getObject({ id: 'obj-1', userId: USER_ID });
    expect(audit.emitted[0]?.requestId).toBe('req-from-context-1');
  });
});
