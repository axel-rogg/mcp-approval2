/**
 * Tests fuer UserSyncService — A11.
 *
 * Plan-Ref: PLAN-as3-autonomous.md §2.2 + A11.
 *
 * Wir mocken den KnowledgeAdapter komplett. Live-Test gegen KC2 in Tier 3.
 *
 * Scope:
 *   - push(args) ruft adapter.syncUser mit korrekten Feldern (inkl. externalId
 *     wenn vorhanden)
 *   - returns true bei success + audit success
 *   - bei adapter-throw: returns false + audit failure, kein throw
 *   - syncArgsFromUser convertet UserRow korrekt (mit/ohne externalId)
 */
import { describe, it, expect, vi } from 'vitest';
import type { KnowledgeAdapter, DbAdapter } from '@mcp-approval2/adapters';
import { createUserSyncService, syncArgsFromUser } from './user-sync.js';

function makeDbStub(): DbAdapter & { audits: Array<Record<string, unknown>> } {
  const audits: Array<Record<string, unknown>> = [];
  const scoped = {
    async query(sql: string, params?: ReadonlyArray<unknown>): Promise<unknown[]> {
      if (sql.includes('INSERT INTO audit_log')) {
        // Schema-Match mit services/audit.ts:
        //   (ts, actor_user_id, actor_type, action, request_id, ip, user_agent, result, details)
        audits.push({ action: params?.[3], result: params?.[7], details: params?.[8] });
      }
      return [];
    },
    drizzle: {} as unknown,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = {
    dialect: 'postgres' as const,
    async scoped() {
      return { ...scoped, userId: 'stub', dialect: 'postgres' as const };
    },
    unsafe() {
      return { ...scoped, dialect: 'postgres' as const };
    },
    async transaction<T>(_uid: string, fn: (sc: typeof scoped) => Promise<T>): Promise<T> {
      return fn(scoped);
    },
    async migrate() {},
    async close() {},
  };
  db.audits = audits;
  return db;
}

function makeAdapter(opts: {
  resolve?: { status: 'created' | 'updated' | 'unchanged'; kcUserId: string };
  reject?: Error;
}): KnowledgeAdapter & { syncCalls: Array<unknown> } {
  const syncCalls: Array<unknown> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter: any = {
    async syncUser(args: unknown) {
      syncCalls.push(args);
      if (opts.reject) throw opts.reject;
      return opts.resolve ?? { status: 'created', kcUserId: 'kc-1' };
    },
  };
  adapter.syncCalls = syncCalls;
  return adapter;
}

describe('UserSyncService.push', () => {
  it('forwards args to adapter + audits success', async () => {
    const db = makeDbStub();
    const adapter = makeAdapter({ resolve: { status: 'created', kcUserId: 'kc-99' } });
    const svc = createUserSyncService({ adapter, db });
    const ok = await svc.push({
      userId: 'user-1',
      email: 'axel@example.org',
      displayName: 'Axel',
      status: 'active',
      externalId: 'google-sub-123',
    });
    expect(ok).toBe(true);
    expect(adapter.syncCalls).toHaveLength(1);
    expect(adapter.syncCalls[0]).toMatchObject({
      userId: 'user-1',
      email: 'axel@example.org',
      status: 'active',
      externalId: 'google-sub-123',
    });
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]?.['action']).toBe('user.sync_to_kc2');
    expect(db.audits[0]?.['result']).toBe('success');
  });

  it('returns false + audits failure on adapter throw (no rethrow)', async () => {
    const db = makeDbStub();
    const adapter = makeAdapter({ reject: new Error('kc unreachable') });
    const svc = createUserSyncService({ adapter, db });
    const ok = await svc.push({
      userId: 'user-1',
      email: 'a@b.de',
      displayName: 'A',
      status: 'suspended',
    });
    expect(ok).toBe(false);
    expect(db.audits).toHaveLength(1);
    // mapResult() in services/audit.ts maps 'failure' → 'error' (Schema-CHECK)
    expect(db.audits[0]?.['result']).toBe('error');
  });
});

describe('syncArgsFromUser', () => {
  it('maps full user-row including externalId', () => {
    const args = syncArgsFromUser({
      id: 'u-1',
      email: 'a@b.de',
      displayName: 'A',
      status: 'active',
      externalId: 'google-sub',
    });
    expect(args).toEqual({
      userId: 'u-1',
      email: 'a@b.de',
      displayName: 'A',
      status: 'active',
      externalId: 'google-sub',
    });
  });

  it('omits externalId when null', () => {
    const args = syncArgsFromUser({
      id: 'u-1',
      email: 'a@b.de',
      displayName: 'A',
      status: 'invited',
      externalId: null,
    });
    expect(args.externalId).toBeUndefined();
    expect(args.status).toBe('invited');
  });
});
