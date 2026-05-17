/**
 * Unit-Tests fuer GdprService.
 *
 * Scope:
 *   - exportUserData liefert NDJSON-Records pro Tabelle + Audit-Eintrag
 *   - requestErase soft-deleted + Queue-Row + revoked sessions + Audit
 *   - cancelErase reaktiviert User + status=cancelled
 *   - hardEraseUser ruft destroyKey + DELETEs + Cascade an KC + pseudo-Update
 *   - listDuePurges liefert pending-Rows wo purge_after_at <= now
 *
 * Mocks: in-memory DB + stub KekProvider + stub KnowledgeService.
 */
import { describe, it, expect } from 'vitest';
import type { DbAdapter, KekProvider, RawDb, ScopedDb, TransactionCtx } from '@mcp-approval2/adapters';
import { createGdprService, type GdprService } from './gdpr.js';
import type { KnowledgeService } from './knowledge.js';

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  status: string;
  external_id: string | null;
  created_at: number;
  last_login_at: number | null;
  invited_by: string | null;
  deleted_at: number | null;
}

interface CredentialRow {
  id: string;
  owner_id: string;
  provider: string;
  kind: string;
  label: string;
  prf_enabled: boolean;
  meta_json: Record<string, unknown> | null;
  created_at: number;
  rotated_at: number | null;
  last_used_at: number | null;
  expires_at: number | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

interface RefreshRow {
  id: string;
  user_id: string;
  session_id: string;
  revoked_at: number | null;
}

interface WaRow {
  id: string;
  user_id: string;
  friendly_name: string | null;
  prf_supported: boolean;
  created_at: number;
  last_used_at: number | null;
  invalidated_at: number | null;
}

interface AuditRow {
  id: string;
  ts: number;
  action: string;
  actor_user_id: string | null;
  target_user_id: string | null;
  result: string;
  details: Record<string, unknown> | null;
  request_id: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
}

interface QueueRow {
  user_id: string;
  requested_at: number;
  purge_after_at: number;
  requested_by: string | null;
  status: string;
  processed_at: number | null;
  failure_reason: string | null;
}

interface State {
  users: Map<string, UserRow>;
  credentials: Map<string, CredentialRow>;
  sessions: Map<string, SessionRow>;
  refreshes: Map<string, RefreshRow>;
  webauthn: Map<string, WaRow>;
  audit: AuditRow[];
  queue: Map<string, QueueRow>;
}

function makeDb(state: State): DbAdapter {
  function exec<T = unknown>(text: string, params: ReadonlyArray<unknown> = []): T[] {
    const t = text.replace(/\s+/g, ' ').trim();

    // ----- users -----
    if (t.startsWith('SELECT id, status FROM users WHERE id = $1')) {
      const u = state.users.get(String(params[0]));
      return (u ? [{ id: u.id, status: u.status }] : []) as unknown as T[];
    }
    if (t.startsWith("UPDATE users SET status = 'deleted'")) {
      const [ts, id] = params as readonly unknown[];
      const u = state.users.get(String(id));
      if (u) {
        u.status = 'deleted';
        u.deleted_at = Number(ts);
      }
      return [] as unknown as T[];
    }
    if (t.startsWith("UPDATE users SET status = 'active', deleted_at = NULL")) {
      const id = String(params[0]);
      const u = state.users.get(id);
      if (u) {
        u.status = 'active';
        u.deleted_at = null;
      }
      return [] as unknown as T[];
    }
    if (t.startsWith('UPDATE users SET email = $1, display_name')) {
      const [email, ts, id] = params as readonly unknown[];
      const u = state.users.get(String(id));
      if (u) {
        u.email = String(email);
        u.display_name = '[deleted]';
        u.external_id = null;
        u.status = 'deleted';
        u.deleted_at = u.deleted_at ?? Number(ts);
      }
      return [] as unknown as T[];
    }
    if (t.startsWith('SELECT id, email, display_name, role, status, created_at')) {
      const u = state.users.get(String(params[0]));
      if (!u) return [] as unknown as T[];
      return [u] as unknown as T[];
    }

    // ----- queue -----
    if (t.startsWith('INSERT INTO gdpr_erase_queue')) {
      const [userId, requestedAt, purgeAfterAt, requestedBy] = params as readonly unknown[];
      state.queue.set(String(userId), {
        user_id: String(userId),
        requested_at: Number(requestedAt),
        purge_after_at: Number(purgeAfterAt),
        requested_by: requestedBy === null || requestedBy === undefined ? null : String(requestedBy),
        status: 'pending',
        processed_at: null,
        failure_reason: null,
      });
      return [] as unknown as T[];
    }
    if (t.startsWith('SELECT user_id, status FROM gdpr_erase_queue WHERE user_id = $1')) {
      const q = state.queue.get(String(params[0]));
      return (q ? [{ user_id: q.user_id, status: q.status }] : []) as unknown as T[];
    }
    if (t.startsWith("UPDATE gdpr_erase_queue SET status = 'cancelled'")) {
      const [ts, userId] = params as readonly unknown[];
      const q = state.queue.get(String(userId));
      if (q && q.status === 'pending') {
        q.status = 'cancelled';
        q.processed_at = Number(ts);
      }
      return [] as unknown as T[];
    }
    if (t.startsWith("UPDATE gdpr_erase_queue SET status = 'processing'")) {
      const userId = String(params[0]);
      const q = state.queue.get(userId);
      if (q && q.status === 'pending') {
        q.status = 'processing';
        return [{ user_id: userId }] as unknown as T[];
      }
      return [] as unknown as T[];
    }
    if (t.startsWith("UPDATE gdpr_erase_queue SET status = 'completed'")) {
      const [ts, userId] = params as readonly unknown[];
      const q = state.queue.get(String(userId));
      if (q) {
        q.status = 'completed';
        q.processed_at = Number(ts);
      }
      return [] as unknown as T[];
    }
    if (t.startsWith("UPDATE gdpr_erase_queue SET status = 'failed'")) {
      const [ts, reason, userId] = params as readonly unknown[];
      const q = state.queue.get(String(userId));
      if (q) {
        q.status = 'failed';
        q.processed_at = Number(ts);
        q.failure_reason = String(reason);
      }
      return [] as unknown as T[];
    }
    if (t.startsWith('SELECT user_id, purge_after_at FROM gdpr_erase_queue')) {
      const now = Number(params[0]);
      const out = Array.from(state.queue.values())
        .filter((q) => q.status === 'pending' && q.purge_after_at <= now)
        .map((q) => ({ user_id: q.user_id, purge_after_at: q.purge_after_at }));
      return out as unknown as T[];
    }

    // ----- sessions / refresh -----
    if (t.startsWith('UPDATE sessions SET revoked_at')) {
      const [ts, userId] = params as readonly unknown[];
      for (const s of state.sessions.values()) {
        if (s.user_id === String(userId) && s.revoked_at === null) s.revoked_at = Number(ts);
      }
      return [] as unknown as T[];
    }
    if (t.startsWith('UPDATE refresh_tokens SET revoked_at')) {
      const [ts, userId] = params as readonly unknown[];
      for (const r of state.refreshes.values()) {
        if (r.user_id === String(userId) && r.revoked_at === null) r.revoked_at = Number(ts);
      }
      return [] as unknown as T[];
    }
    if (t.startsWith('DELETE FROM credentials WHERE owner_id')) {
      const ownerId = String(params[0]);
      const out: { id: string }[] = [];
      for (const [id, c] of state.credentials) {
        if (c.owner_id === ownerId) {
          out.push({ id });
          state.credentials.delete(id);
        }
      }
      return out as unknown as T[];
    }
    if (t.startsWith('DELETE FROM sessions WHERE user_id')) {
      const userId = String(params[0]);
      const out: { id: string }[] = [];
      for (const [id, s] of state.sessions) {
        if (s.user_id === userId) {
          out.push({ id });
          state.sessions.delete(id);
        }
      }
      return out as unknown as T[];
    }
    if (t.startsWith('DELETE FROM refresh_tokens WHERE user_id')) {
      const userId = String(params[0]);
      const out: { id: string }[] = [];
      for (const [id, r] of state.refreshes) {
        if (r.user_id === userId) {
          out.push({ id });
          state.refreshes.delete(id);
        }
      }
      return out as unknown as T[];
    }
    if (t.startsWith('DELETE FROM webauthn_credentials WHERE user_id')) {
      const userId = String(params[0]);
      const out: { id: string }[] = [];
      for (const [id, w] of state.webauthn) {
        if (w.user_id === userId) {
          out.push({ id });
          state.webauthn.delete(id);
        }
      }
      return out as unknown as T[];
    }

    // ----- SELECT for export -----
    if (t.startsWith('SELECT id, provider, kind, label, prf_enabled')) {
      const ownerId = String(params[0]);
      return Array.from(state.credentials.values()).filter((c) => c.owner_id === ownerId) as unknown as T[];
    }
    if (t.startsWith('SELECT id, created_at, expires_at, device_id, ip, user_agent')) {
      const userId = String(params[0]);
      return Array.from(state.sessions.values()).filter((s) => s.user_id === userId) as unknown as T[];
    }
    if (t.startsWith('SELECT id, friendly_name, transports, prf_supported')) {
      const userId = String(params[0]);
      return Array.from(state.webauthn.values()).filter((w) => w.user_id === userId) as unknown as T[];
    }
    if (t.startsWith('SELECT id, ts, action, resource_kind, resource_id, result')) {
      const userId = String(params[0]);
      return state.audit
        .filter((a) => a.actor_user_id === userId)
        .map((a) => ({
          id: a.id,
          ts: a.ts,
          action: a.action,
          result: a.result,
          details: a.details,
        })) as unknown as T[];
    }

    // ----- audit_log INSERT -----
    // Shape muss mit services/audit.ts INSERT-Statement uebereinstimmen:
    //   INSERT INTO audit_log
    //     (ts, actor_user_id, actor_type, action, request_id, ip, user_agent, result, details)
    //   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    // (target_user_id wandert in details.targetUserId; column existiert nicht im DB-Schema —
    //  siehe migrations/0001_initial.sql + services/audit.ts header-Kommentar)
    if (t.startsWith('INSERT INTO audit_log')) {
      const [ts, actorUserId, actorType, action, requestId, ip, userAgent, result, details] =
        params as readonly unknown[];
      const parsedDetails = details
        ? (JSON.parse(String(details)) as Record<string, unknown>)
        : null;
      state.audit.push({
        id: `audit-${state.audit.length + 1}`,
        ts: Number(ts),
        action: String(action),
        actor_user_id: actorUserId === null ? null : String(actorUserId),
        target_user_id:
          parsedDetails && typeof parsedDetails['targetUserId'] === 'string'
            ? (parsedDetails['targetUserId'] as string)
            : null,
        result: String(result),
        details: parsedDetails,
        request_id: requestId === null ? null : String(requestId),
        ip: ip === null ? null : String(ip),
        user_agent: userAgent === null ? null : String(userAgent),
        created_at: Number(ts),
        actor_type: String(actorType),
      });
      return [] as unknown as T[];
    }

    throw new Error(`unmocked SQL: ${t.slice(0, 100)}`);
  }

  const scoped: ScopedDb = {
    userId: 'system',
    dialect: 'postgres',
    drizzle: {},
    async query<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
      return exec<T>(sql, params);
    },
  };
  const raw: RawDb = {
    dialect: 'postgres',
    drizzle: {},
    async query<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
      return exec<T>(sql, params);
    },
  };
  return {
    dialect: 'postgres',
    async scoped() {
      return scoped;
    },
    unsafe() {
      return raw;
    },
    async transaction<T>(userId: string, fn: (tx: ScopedDb, ctx: TransactionCtx) => Promise<T>) {
      return fn(scoped, { userId, dialect: 'postgres' });
    },
    async migrate() {},
    async close() {},
  };
}

function makeKek(destroyCalls: string[]): KekProvider {
  return {
    async wrap(dek: Uint8Array) {
      return dek;
    },
    async unwrap(wrapped: Uint8Array) {
      return wrapped;
    },
    async rotate() {},
    async destroyKey(ref: string) {
      destroyCalls.push(ref);
    },
  };
}

function makeKnowledge(calls: { erase: number; list: number }): KnowledgeService {
  return {
    async eraseUser() {
      calls.erase++;
      return { deletedRows: 7 };
    },
    async listObjects() {
      calls.list++;
      return { items: [], cursor: null, hasMore: false };
    },
  } as unknown as KnowledgeService;
}

function emptyState(): State {
  return {
    users: new Map(),
    credentials: new Map(),
    sessions: new Map(),
    refreshes: new Map(),
    webauthn: new Map(),
    audit: [],
    queue: new Map(),
  };
}

const USER_ID = '11111111-1111-1111-1111-111111111111';
const ADMIN_ID = '99999999-9999-9999-9999-999999999999';

function seedUser(state: State, id: string = USER_ID): void {
  state.users.set(id, {
    id,
    email: 'user@example.com',
    display_name: 'Test User',
    role: 'member',
    status: 'active',
    external_id: 'google-sub-123',
    created_at: 1000,
    last_login_at: 2000,
    invited_by: null,
    deleted_at: null,
  });
}

function buildService(state: State, opts: { knowledge?: KnowledgeService; destroyCalls?: string[] } = {}): GdprService {
  const destroyCalls = opts.destroyCalls ?? [];
  return createGdprService({
    db: makeDb(state),
    kekProvider: makeKek(destroyCalls),
    ...(opts.knowledge ? { knowledge: opts.knowledge } : {}),
    gracePeriodMs: 1000, // 1 sec fuer Tests
    now: () => 10_000,
  });
}

describe('GdprService.requestErase', () => {
  it('soft-deletes user + writes queue-row + revokes sessions + emits audit', async () => {
    const state = emptyState();
    seedUser(state);
    state.sessions.set('s1', {
      id: 's1',
      user_id: USER_ID,
      created_at: 0,
      expires_at: 9999,
      revoked_at: null,
    });
    const svc = buildService(state);
    const result = await svc.requestErase({ userId: USER_ID, actorUserId: USER_ID });
    expect(result.purgeAfterAt).toBe(11_000);
    expect(state.users.get(USER_ID)?.status).toBe('deleted');
    expect(state.queue.get(USER_ID)?.status).toBe('pending');
    expect(state.sessions.get('s1')?.revoked_at).toBe(10_000);
    expect(state.audit.find((a) => a.action === 'user.erase.requested')).toBeDefined();
  });

  it('throws conflict if user already deleted', async () => {
    const state = emptyState();
    seedUser(state);
    state.users.get(USER_ID)!.status = 'deleted';
    const svc = buildService(state);
    await expect(svc.requestErase({ userId: USER_ID, actorUserId: USER_ID })).rejects.toMatchObject(
      { code: 'conflict' },
    );
  });

  it('throws not-found if user does not exist', async () => {
    const state = emptyState();
    const svc = buildService(state);
    await expect(svc.requestErase({ userId: USER_ID, actorUserId: USER_ID })).rejects.toMatchObject(
      { code: 'not_found' },
    );
  });
});

describe('GdprService.cancelErase', () => {
  it('cancels pending queue + reactivates user', async () => {
    const state = emptyState();
    seedUser(state);
    const svc = buildService(state);
    await svc.requestErase({ userId: USER_ID, actorUserId: USER_ID });
    await svc.cancelErase({ userId: USER_ID, actorUserId: USER_ID });
    expect(state.users.get(USER_ID)?.status).toBe('active');
    expect(state.queue.get(USER_ID)?.status).toBe('cancelled');
    expect(state.audit.find((a) => a.action === 'user.erase.cancelled')).toBeDefined();
  });

  it('rejects when no pending request', async () => {
    const state = emptyState();
    seedUser(state);
    const svc = buildService(state);
    await expect(svc.cancelErase({ userId: USER_ID, actorUserId: USER_ID })).rejects.toMatchObject(
      { code: 'not_found' },
    );
  });
});

describe('GdprService.hardEraseUser', () => {
  it('destroys KEK + deletes local rows + cascades to knowledge + pseudonymizes user', async () => {
    const state = emptyState();
    seedUser(state);
    state.credentials.set('c1', {
      id: 'c1',
      owner_id: USER_ID,
      provider: 'jira',
      kind: 'api_token',
      label: 'work',
      prf_enabled: true,
      meta_json: null,
      created_at: 0,
      rotated_at: null,
      last_used_at: null,
      expires_at: null,
    });
    state.sessions.set('s1', {
      id: 's1',
      user_id: USER_ID,
      created_at: 0,
      expires_at: 9999,
      revoked_at: null,
    });
    state.webauthn.set('w1', {
      id: 'w1',
      user_id: USER_ID,
      friendly_name: 'phone',
      prf_supported: true,
      created_at: 0,
      last_used_at: null,
      invalidated_at: null,
    });

    const destroyCalls: string[] = [];
    const knowledgeCalls = { erase: 0, list: 0 };
    const svc = buildService(state, {
      destroyCalls,
      knowledge: makeKnowledge(knowledgeCalls),
    });
    await svc.requestErase({ userId: USER_ID, actorUserId: ADMIN_ID });

    const result = await svc.hardEraseUser({
      userId: USER_ID,
      actorUserId: ADMIN_ID,
      confirmationToken: 'token-xyz-12345',
    });
    expect(destroyCalls).toEqual([`vault://transit/keys/user-${USER_ID}`]);
    expect(state.credentials.size).toBe(0);
    expect(state.sessions.size).toBe(0);
    expect(state.webauthn.size).toBe(0);
    expect(state.users.get(USER_ID)?.email).toBe(`[deleted-${USER_ID}]`);
    expect(state.users.get(USER_ID)?.external_id).toBeNull();
    expect(knowledgeCalls.erase).toBe(1);
    expect(state.queue.get(USER_ID)?.status).toBe('completed');
    expect(result.deletedLocalRows).toBe(3);
    expect(result.deletedKnowledgeRows).toBe(7);
    const audit = state.audit.find((a) => a.action === 'user.erased');
    expect(audit?.result).toBe('success');
  });

  it('marks queue as failed if destroyKey throws', async () => {
    const state = emptyState();
    seedUser(state);
    const svc = createGdprService({
      db: makeDb(state),
      kekProvider: {
        async wrap(d) {
          return d;
        },
        async unwrap(d) {
          return d;
        },
        async rotate() {},
        async destroyKey() {
          throw new Error('vault unreachable');
        },
      },
      gracePeriodMs: 1000,
      now: () => 10_000,
    });
    await svc.requestErase({ userId: USER_ID, actorUserId: ADMIN_ID });
    await expect(
      svc.hardEraseUser({
        userId: USER_ID,
        actorUserId: ADMIN_ID,
        confirmationToken: 't',
      }),
    ).rejects.toThrow('vault unreachable');
    expect(state.queue.get(USER_ID)?.status).toBe('failed');
    expect(state.queue.get(USER_ID)?.failure_reason).toContain('vault unreachable');
  });
});

describe('GdprService.exportUserData', () => {
  it('yields records per table and emits audit', async () => {
    const state = emptyState();
    seedUser(state);
    state.credentials.set('c1', {
      id: 'c1',
      owner_id: USER_ID,
      provider: 'jira',
      kind: 'api_token',
      label: 'work',
      prf_enabled: true,
      meta_json: { scope: 'read' },
      created_at: 0,
      rotated_at: null,
      last_used_at: null,
      expires_at: null,
    });
    state.sessions.set('s1', {
      id: 's1',
      user_id: USER_ID,
      created_at: 100,
      expires_at: 9999,
      revoked_at: null,
    });
    state.audit.push({
      id: 'a-old',
      ts: 50,
      action: 'auth.login.success',
      actor_user_id: USER_ID,
      target_user_id: null,
      result: 'success',
      details: null,
      request_id: null,
      ip: null,
      user_agent: null,
      created_at: 50,
    });

    const svc = buildService(state);
    const records: Array<{ table: string; row: Record<string, unknown> }> = [];
    for await (const r of svc.exportUserData({ userId: USER_ID, actorUserId: USER_ID })) {
      records.push(r);
    }
    const tables = new Set(records.map((r) => r.table));
    expect(tables.has('users')).toBe(true);
    expect(tables.has('credentials_meta')).toBe(true);
    expect(tables.has('sessions')).toBe(true);
    expect(tables.has('audit_log')).toBe(true);

    // KEINE Secrets!
    const credRecord = records.find((r) => r.table === 'credentials_meta');
    expect(credRecord?.row['ciphertext']).toBeUndefined();
    expect(credRecord?.row['wrapped_dek']).toBeUndefined();
    expect(credRecord?.row['nonce']).toBeUndefined();

    // Audit-Eintrag fuer den Export selbst.
    expect(state.audit.find((a) => a.action === 'data.exported')).toBeDefined();
  });
});

describe('GdprService.listDuePurges', () => {
  it('returns only pending rows with purge_after_at <= now', async () => {
    const state = emptyState();
    seedUser(state, USER_ID);
    seedUser(state, '22222222-2222-2222-2222-222222222222');
    state.queue.set(USER_ID, {
      user_id: USER_ID,
      requested_at: 0,
      purge_after_at: 100,
      requested_by: null,
      status: 'pending',
      processed_at: null,
      failure_reason: null,
    });
    state.queue.set('22222222-2222-2222-2222-222222222222', {
      user_id: '22222222-2222-2222-2222-222222222222',
      requested_at: 0,
      purge_after_at: 999_999,
      requested_by: null,
      status: 'pending',
      processed_at: null,
      failure_reason: null,
    });
    const svc = buildService(state);
    const due = await svc.listDuePurges(500);
    expect(due).toHaveLength(1);
    expect(due[0]?.userId).toBe(USER_ID);
  });
});
