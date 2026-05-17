/**
 * Unit-Tests fuer ApprovalService.
 *
 * Scope: create → approve / reject / sweepExpired Lifecycle, Display-Template
 * Rendering, Cross-User-Reject (RLS-simuliert via userId-mismatch), Idempotency.
 *
 * Mocks: minimaler in-memory DbAdapter (Map-based), kein echtes Postgres.
 * Audit-Sink schluckt Events still.
 */
import { describe, it, expect } from 'vitest';
import type { DbAdapter, ScopedDb, RawDb, TransactionCtx } from '@mcp-approval2/adapters';
import { randomUuidV4 } from '@mcp-approval2/core';
import {
  ApprovalConflictError,
  createApprovalService,
  renderDisplayTemplate,
} from './approvals.js';

interface ApprovalRow {
  id: string;
  user_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  display_template: string | null;
  display_rendered: string | null;
  sensitivity: string;
  status: string;
  approval_challenge: string | null;
  approval_signature: Uint8Array | null;
  approved_at: number | null;
  rejected_at: number | null;
  rejection_reason: string | null;
  expired_at: number | null;
  prf_session_id: string | null;
  result_json: Record<string, unknown> | null;
  result_emitted_at: number | null;
  request_id: string | null;
  origin_ip: string | null;
  created_at: number;
  expires_at: number;
}

function makeMemoryDb(): DbAdapter & { _rows: Map<string, ApprovalRow>; _audit: unknown[] } {
  const rows = new Map<string, ApprovalRow>();
  const audit: unknown[] = [];

  function exec<T = unknown>(text: string, params: ReadonlyArray<unknown> = []): T[] {
    const t = text.replace(/\s+/g, ' ').trim();

    if (t.startsWith('INSERT INTO pending_approvals')) {
      const [
        user_id,
        tool_name,
        tool_input_str,
        display_template,
        display_rendered,
        sensitivity,
        approval_challenge,
        request_id,
        origin_ip,
        created_at,
        expires_at,
      ] = params as readonly unknown[];
      const row: ApprovalRow = {
        id: randomUuidV4(),
        user_id: String(user_id),
        tool_name: String(tool_name),
        tool_input: JSON.parse(String(tool_input_str)) as Record<string, unknown>,
        display_template: (display_template ?? null) as string | null,
        display_rendered: (display_rendered ?? null) as string | null,
        sensitivity: String(sensitivity),
        status: 'pending',
        approval_challenge: (approval_challenge ?? null) as string | null,
        approval_signature: null,
        approved_at: null,
        rejected_at: null,
        rejection_reason: null,
        expired_at: null,
        prf_session_id: null,
        result_json: null,
        result_emitted_at: null,
        request_id: (request_id ?? null) as string | null,
        origin_ip: (origin_ip ?? null) as string | null,
        created_at: Number(created_at),
        expires_at: Number(expires_at),
      };
      rows.set(row.id, row);
      return [row] as unknown as T[];
    }

    if (
      t.startsWith('SELECT') &&
      t.includes('FROM pending_approvals WHERE id = $1 AND user_id = $2')
    ) {
      const [id, user_id] = params as readonly unknown[];
      const r = rows.get(String(id));
      if (r && r.user_id === String(user_id)) return [r] as unknown as T[];
      return [] as unknown as T[];
    }

    if (
      t.startsWith('SELECT') &&
      t.includes('FROM pending_approvals WHERE user_id = $1 AND status = $2')
    ) {
      const [user_id, status, limit] = params as readonly unknown[];
      const out = Array.from(rows.values())
        .filter((r) => r.user_id === String(user_id) && r.status === String(status))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, Number(limit));
      return out as unknown as T[];
    }

    if (
      t.startsWith('SELECT') &&
      t.includes('FROM pending_approvals WHERE user_id = $1')
    ) {
      const [user_id, limit] = params as readonly unknown[];
      const out = Array.from(rows.values())
        .filter((r) => r.user_id === String(user_id))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, Number(limit));
      return out as unknown as T[];
    }

    if (
      t.startsWith("UPDATE pending_approvals SET status = 'approved'")
    ) {
      const [signature, approved_at, prf_session_id, id, user_id] =
        params as readonly unknown[];
      const r = rows.get(String(id));
      if (!r || r.user_id !== String(user_id) || r.status !== 'pending') {
        return [] as unknown as T[];
      }
      r.status = 'approved';
      r.approval_signature = signature as Uint8Array;
      r.approved_at = Number(approved_at);
      r.prf_session_id = (prf_session_id ?? null) as string | null;
      return [r] as unknown as T[];
    }

    if (
      t.startsWith("UPDATE pending_approvals SET status = 'rejected'")
    ) {
      const [rejected_at, reason, id, user_id] = params as readonly unknown[];
      const r = rows.get(String(id));
      if (!r || r.user_id !== String(user_id) || r.status !== 'pending') {
        return [] as unknown as T[];
      }
      r.status = 'rejected';
      r.rejected_at = Number(rejected_at);
      r.rejection_reason = (reason ?? null) as string | null;
      return [r] as unknown as T[];
    }

    if (
      t.startsWith("UPDATE pending_approvals SET status = 'expired'") &&
      t.includes("WHERE status = 'pending' AND expires_at < $1")
    ) {
      // Sweep: WHERE status='pending' AND expires_at < $1 RETURNING id
      const [now] = params as readonly unknown[];
      const out: { id: string }[] = [];
      for (const r of rows.values()) {
        if (r.status === 'pending' && r.expires_at < Number(now)) {
          r.status = 'expired';
          r.expired_at = Number(now);
          out.push({ id: r.id });
        }
      }
      return out as unknown as T[];
    }

    if (
      t.startsWith("UPDATE pending_approvals SET status = 'expired'")
    ) {
      // Auto-expire single (used during approve when row is stale): [now, id]
      const [now, id] = params as readonly unknown[];
      const r = rows.get(String(id));
      if (r && r.status === 'pending') {
        r.status = 'expired';
        r.expired_at = Number(now);
      }
      return [] as unknown as T[];
    }

    if (t.startsWith('UPDATE pending_approvals SET result_json')) {
      const [result_json_str, ts, id] = params as readonly unknown[];
      const r = rows.get(String(id));
      // SEC-018: CAS — nur schreiben wenn result_emitted_at IS NULL.
      if (r && r.result_emitted_at === null) {
        r.result_json = JSON.parse(String(result_json_str)) as Record<string, unknown>;
        r.result_emitted_at = Number(ts);
      }
      return [] as unknown as T[];
    }

    if (t.startsWith('INSERT INTO audit_log')) {
      audit.push(params);
      return [] as unknown as T[];
    }

    throw new Error(`unmocked SQL: ${t.slice(0, 100)}`);
  }

  const scoped = (userId: string): ScopedDb => ({
    userId,
    dialect: 'postgres',
    drizzle: {},
    async query<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
      return exec<T>(sql, params);
    },
  });

  const rawDb: RawDb = {
    dialect: 'postgres',
    drizzle: {},
    async query<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
      return exec<T>(sql, params);
    },
  };

  const adapter: DbAdapter & { _rows: Map<string, ApprovalRow>; _audit: unknown[] } = {
    dialect: 'postgres',
    _rows: rows,
    _audit: audit,
    async scoped(userId: string) {
      return scoped(userId);
    },
    unsafe(_reason: string) {
      return rawDb;
    },
    async transaction<T>(
      userId: string,
      fn: (tx: ScopedDb, ctx: TransactionCtx) => Promise<T>,
    ): Promise<T> {
      return fn(scoped(userId), { userId, dialect: 'postgres' });
    },
    async migrate() {},
    async close() {},
  };
  return adapter;
}

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

describe('renderDisplayTemplate', () => {
  it('returns null when template is undefined', () => {
    expect(renderDisplayTemplate(undefined, { foo: 'bar' })).toBeNull();
  });

  it('substitutes top-level field', () => {
    expect(renderDisplayTemplate('Hello {{name}}!', { name: 'Axel' })).toBe('Hello Axel!');
  });

  it('substitutes nested field', () => {
    expect(
      renderDisplayTemplate('id={{user.id}} role={{user.role}}', {
        user: { id: 'u-1', role: 'admin' },
      }),
    ).toBe('id=u-1 role=admin');
  });

  it('supports .length for strings + arrays', () => {
    expect(renderDisplayTemplate('chars={{body.length}}', { body: 'hi!' })).toBe('chars=3');
    expect(
      renderDisplayTemplate('items={{xs.length}}', { xs: [1, 2, 3, 4] }),
    ).toBe('items=4');
  });

  it('strips HTML tags', () => {
    expect(
      renderDisplayTemplate('msg=<b>{{m}}</b>', { m: '<script>alert(1)</script>' }),
    ).toBe('msg=alert(1)');
  });

  it('clamps to 500 chars', () => {
    const big = 'x'.repeat(2000);
    const out = renderDisplayTemplate('start {{big}}', { big });
    expect(out!.length).toBe(500);
    expect(out!.endsWith('…')).toBe(true);
  });

  it('renders unknown paths as ?', () => {
    expect(renderDisplayTemplate('a={{missing}}', { other: 'x' })).toBe('a=?');
  });

  it('blocks __proto__/constructor traversal', () => {
    expect(renderDisplayTemplate('p={{__proto__}}', {})).toBe('p=?');
    expect(renderDisplayTemplate('p={{constructor.name}}', {})).toBe('p=?');
  });

  it('formats arrays/objects compactly', () => {
    expect(renderDisplayTemplate('xs={{xs}}', { xs: [1, 2, 3] })).toBe('xs=[3 items]');
    expect(renderDisplayTemplate('o={{o}}', { o: { a: 1 } })).toBe('o=[object]');
  });

  // SEC-020: preview-Filter clampt einzelne Werte.
  it('SEC-020: |preview:N truncates long values with ellipsis', () => {
    expect(
      renderDisplayTemplate('body:{{body|preview:10}}', { body: 'abcdefghijklmnopqrstuvwxyz' }),
    ).toBe('body:abcdefghi…');
  });

  it('SEC-020: |preview:N passt durch wenn Wert kuerzer als N', () => {
    expect(
      renderDisplayTemplate('body:{{body|preview:50}}', { body: 'short' }),
    ).toBe('body:short');
  });

  it('SEC-020: |preview wird gegen unbekannte Pfade als "?" gerendert', () => {
    expect(renderDisplayTemplate('body:{{missing|preview:20}}', {})).toBe('body:?');
  });

  it('SEC-020: |preview:N respektiert 1..200 range', () => {
    // Cap >200 → 200
    const long = 'x'.repeat(300);
    const out = renderDisplayTemplate('b:{{b|preview:500}}', { b: long });
    // 500 ist out-of-range → effektiv 200; +"b:" + "…" prefix
    expect(out?.length).toBeLessThanOrEqual(2 + 200);
  });
});

describe('ApprovalService', () => {
  it('create + get roundtrip', async () => {
    const db = makeMemoryDb();
    const svc = createApprovalService({ db });
    const a = await svc.create({
      userId: USER_A,
      toolName: 'docs.put',
      toolInput: { title: 'Foo', body: 'Hello' },
      sensitivity: 'write',
      displayTemplate: 'Create doc {{title}} ({{body.length}} chars)',
    });
    expect(a.status).toBe('pending');
    expect(a.toolName).toBe('docs.put');
    expect(a.displayRendered).toBe('Create doc Foo (5 chars)');
    expect(a.approvalChallenge).toBeTruthy();
    expect(a.expiresAt).toBeGreaterThan(a.createdAt);

    const fetched = await svc.get({ id: a.id, userId: USER_A });
    expect(fetched?.id).toBe(a.id);
  });

  it('get for wrong user → null', async () => {
    const db = makeMemoryDb();
    const svc = createApprovalService({ db });
    const a = await svc.create({
      userId: USER_A,
      toolName: 'docs.put',
      toolInput: {},
      sensitivity: 'write',
    });
    const fetched = await svc.get({ id: a.id, userId: USER_B });
    expect(fetched).toBeNull();
  });

  it('approve happy-path', async () => {
    const db = makeMemoryDb();
    const svc = createApprovalService({ db });
    const a = await svc.create({
      userId: USER_A,
      toolName: 'docs.put',
      toolInput: {},
      sensitivity: 'write',
    });
    const sig = new Uint8Array([1, 2, 3, 4]);
    const approved = await svc.approve({
      id: a.id,
      userId: USER_A,
      signature: sig,
    });
    expect(approved.status).toBe('approved');
    expect(approved.approvedAt).toBeGreaterThan(0);
    expect(approved.approvalSignature).toEqual(sig);
  });

  it('approve from wrong user → not found', async () => {
    const db = makeMemoryDb();
    const svc = createApprovalService({ db });
    const a = await svc.create({
      userId: USER_A,
      toolName: 'docs.put',
      toolInput: {},
      sensitivity: 'write',
    });
    await expect(
      svc.approve({
        id: a.id,
        userId: USER_B,
        signature: new Uint8Array([9]),
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('approve on already-approved → 409 ApprovalConflictError', async () => {
    const db = makeMemoryDb();
    const svc = createApprovalService({ db });
    const a = await svc.create({
      userId: USER_A,
      toolName: 'docs.put',
      toolInput: {},
      sensitivity: 'write',
    });
    await svc.approve({ id: a.id, userId: USER_A, signature: new Uint8Array([1]) });
    await expect(
      svc.approve({ id: a.id, userId: USER_A, signature: new Uint8Array([2]) }),
    ).rejects.toBeInstanceOf(ApprovalConflictError);
  });

  it('approve on rejected → 409', async () => {
    const db = makeMemoryDb();
    const svc = createApprovalService({ db });
    const a = await svc.create({
      userId: USER_A,
      toolName: 'docs.put',
      toolInput: {},
      sensitivity: 'write',
    });
    await svc.reject({ id: a.id, userId: USER_A, reason: 'nope' });
    await expect(
      svc.approve({ id: a.id, userId: USER_A, signature: new Uint8Array([1]) }),
    ).rejects.toBeInstanceOf(ApprovalConflictError);
  });

  it('reject happy-path + audit emit', async () => {
    const db = makeMemoryDb();
    const svc = createApprovalService({ db });
    const a = await svc.create({
      userId: USER_A,
      toolName: 'docs.put',
      toolInput: {},
      sensitivity: 'write',
    });
    const rejected = await svc.reject({
      id: a.id,
      userId: USER_A,
      reason: 'looks dangerous',
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionReason).toBe('looks dangerous');
    expect(rejected.rejectedAt).toBeGreaterThan(0);

    // Audit-Trail: created + rejected
    // Schema-Match mit services/audit.ts: action ist params[3] (Schema-Drift-Fix 2026-05-17).
    const actions = db._audit.map((p) => (p as ReadonlyArray<unknown>)[3]);
    expect(actions).toContain('tool.approval.created');
    expect(actions).toContain('tool.approval.rejected');
  });

  it('expire-sweep flips pending → expired when past TTL', async () => {
    const db = makeMemoryDb();
    let nowVal = 1_000_000;
    const svc = createApprovalService({ db, now: () => nowVal });
    const a = await svc.create({
      userId: USER_A,
      toolName: 'docs.put',
      toolInput: {},
      sensitivity: 'write',
      ttlSec: 60,
    });
    // Fast-forward past TTL
    nowVal += 61 * 1000;
    const swept = await svc.sweepExpired();
    expect(swept).toBe(1);
    const fetched = await svc.get({ id: a.id, userId: USER_A });
    expect(fetched?.status).toBe('expired');
    expect(fetched?.expiredAt).toBeGreaterThan(0);
  });

  it('approve on expired pending auto-flips + 409', async () => {
    const db = makeMemoryDb();
    let nowVal = 1_000_000;
    const svc = createApprovalService({ db, now: () => nowVal });
    const a = await svc.create({
      userId: USER_A,
      toolName: 'docs.put',
      toolInput: {},
      sensitivity: 'write',
      ttlSec: 30,
    });
    nowVal += 31 * 1000;
    await expect(
      svc.approve({ id: a.id, userId: USER_A, signature: new Uint8Array([1]) }),
    ).rejects.toBeInstanceOf(ApprovalConflictError);
    const fetched = await svc.get({ id: a.id, userId: USER_A });
    expect(fetched?.status).toBe('expired');
  });

  it('list filters by status', async () => {
    const db = makeMemoryDb();
    const svc = createApprovalService({ db });
    const a1 = await svc.create({
      userId: USER_A,
      toolName: 'docs.put',
      toolInput: { i: 1 },
      sensitivity: 'write',
    });
    await svc.create({
      userId: USER_A,
      toolName: 'docs.put',
      toolInput: { i: 2 },
      sensitivity: 'write',
    });
    await svc.reject({ id: a1.id, userId: USER_A });

    const allPending = await svc.list({ userId: USER_A, status: 'pending' });
    expect(allPending).toHaveLength(1);
    const allRejected = await svc.list({ userId: USER_A, status: 'rejected' });
    expect(allRejected).toHaveLength(1);
    expect(allRejected[0]?.id).toBe(a1.id);

    const everything = await svc.list({ userId: USER_A });
    expect(everything).toHaveLength(2);
  });

  it('list isolates per user', async () => {
    const db = makeMemoryDb();
    const svc = createApprovalService({ db });
    await svc.create({
      userId: USER_A,
      toolName: 'docs.put',
      toolInput: {},
      sensitivity: 'write',
    });
    await svc.create({
      userId: USER_B,
      toolName: 'docs.put',
      toolInput: {},
      sensitivity: 'write',
    });
    const listA = await svc.list({ userId: USER_A });
    const listB = await svc.list({ userId: USER_B });
    expect(listA).toHaveLength(1);
    expect(listB).toHaveLength(1);
    expect(listA[0]?.userId).toBe(USER_A);
    expect(listB[0]?.userId).toBe(USER_B);
  });

  it('setResult persists tool output', async () => {
    const db = makeMemoryDb();
    const svc = createApprovalService({ db });
    const a = await svc.create({
      userId: USER_A,
      toolName: 'docs.put',
      toolInput: {},
      sensitivity: 'write',
    });
    await svc.setResult({ id: a.id, result: { ok: true, doc_id: 'd-1' } });
    const fetched = await svc.get({ id: a.id, userId: USER_A });
    expect(fetched?.resultJson).toEqual({ ok: true, doc_id: 'd-1' });
    expect(fetched?.resultEmittedAt).toBeGreaterThan(0);
  });

  // SEC-018: setResult ist single-write — ein zweiter Aufruf darf das erste
  // Result NICHT ueberschreiben.
  it('setResult is single-write (CAS on result_emitted_at IS NULL)', async () => {
    const db = makeMemoryDb();
    const svc = createApprovalService({ db });
    const a = await svc.create({
      userId: USER_A,
      toolName: 'docs.put',
      toolInput: {},
      sensitivity: 'write',
    });
    await svc.setResult({ id: a.id, result: { ok: true, doc_id: 'first' } });
    const first = await svc.get({ id: a.id, userId: USER_A });
    const firstEmittedAt = first?.resultEmittedAt;
    // Re-set: muss no-op sein.
    await svc.setResult({ id: a.id, result: { ok: false, doc_id: 'second' } });
    const after = await svc.get({ id: a.id, userId: USER_A });
    expect(after?.resultJson).toEqual({ ok: true, doc_id: 'first' });
    expect(after?.resultEmittedAt).toBe(firstEmittedAt);
  });

  it('rejects ttlSec out-of-range', async () => {
    const db = makeMemoryDb();
    const svc = createApprovalService({ db });
    await expect(
      svc.create({
        userId: USER_A,
        toolName: 'x',
        toolInput: {},
        sensitivity: 'write',
        ttlSec: 0,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      svc.create({
        userId: USER_A,
        toolName: 'x',
        toolInput: {},
        sensitivity: 'write',
        ttlSec: 99_999,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
