/**
 * Unit-Tests fuer CostTracker.
 *
 * Scope:
 *   - precheck: under-budget → allowed=true, soft-limit-flag
 *   - precheck: over-budget → allowed=false, reason
 *   - record: INSERT in cost_ledger
 *   - getDaily: SUM-Aggregation
 *   - estimateChat / estimateEmbed: hardcoded pricing-Math
 *
 * Mocks: minimal in-memory DbAdapter mit SQL-Substring-Match.
 */
import { describe, expect, it } from 'vitest';
import type {
  DbAdapter,
  RawDb,
  ScopedDb,
  TransactionCtx,
} from '@mcp-approval2/adapters';
import { createCostTracker } from './cost-tracker.js';

interface LedgerRow {
  user_id: string;
  date: string;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  embedding_tokens: number;
  total_usd: number;
  call_count: number;
  request_id: string | null;
  created_at: number;
}

function makeMemoryDb(): DbAdapter & { rows: LedgerRow[] } {
  const rows: LedgerRow[] = [];

  function exec<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): T[] {
    const t = sql.replace(/\s+/g, ' ').trim();
    if (t.startsWith('INSERT INTO cost_ledger')) {
      const [
        user_id,
        date,
        provider,
        model,
        prompt_tokens,
        completion_tokens,
        embedding_tokens,
        total_usd,
        request_id,
        created_at,
      ] = params as [
        string,
        string,
        string,
        string,
        number,
        number,
        number,
        number,
        string | null,
        number,
      ];
      rows.push({
        user_id,
        date,
        provider,
        model,
        prompt_tokens,
        completion_tokens,
        embedding_tokens,
        total_usd,
        call_count: 1,
        request_id,
        created_at,
      });
      return [] as T[];
    }
    if (t.startsWith('SELECT COALESCE(SUM(total_usd)')) {
      const [userId, date] = params as [string, string];
      const matching = rows.filter((r) => r.user_id === userId && r.date === date);
      const total = matching.reduce((s, r) => s + r.total_usd, 0);
      const calls = matching.reduce((s, r) => s + r.call_count, 0);
      return [{ total_usd: total, calls }] as unknown as T[];
    }
    throw new Error(`unmocked SQL: ${t.slice(0, 80)}`);
  }

  const rawDb: RawDb = {
    dialect: 'postgres',
    drizzle: {},
    async query<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
      return exec<T>(sql, params);
    },
  };
  const scoped = (userId: string): ScopedDb => ({
    userId,
    dialect: 'postgres',
    drizzle: {},
    async query<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
      return exec<T>(sql, params);
    },
  });

  const adapter: DbAdapter & { rows: LedgerRow[] } = {
    dialect: 'postgres',
    rows,
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

const FIXED_NOW = Date.parse('2026-05-13T12:00:00Z');
const FIXED_DATE = '2026-05-13';

describe('CostTracker', () => {
  it('estimateChat applies pricing-table + 5% overhead', () => {
    const db = makeMemoryDb();
    const tracker = createCostTracker({ db });
    // gemini-2.0-flash-exp: $0.10/M in, $0.40/M out
    //   1000 prompt + 500 completion
    //   = 1000 * 1e-7 + 500 * 4e-7 = 1e-4 + 2e-4 = 3e-4
    //   * 1.05 = 3.15e-4
    const est = tracker.estimateChat({
      model: 'gemini-2.0-flash-exp',
      promptTokens: 1000,
      completionTokens: 500,
    });
    expect(est).toBeCloseTo(3.15e-4, 7);
  });

  it('estimateEmbed for text-embedding-005', () => {
    const db = makeMemoryDb();
    const tracker = createCostTracker({ db });
    // text-embedding-005: $0.025/M = 2.5e-8 / token
    // 10_000 tokens * 2.5e-8 * 1.05 = 2.625e-4
    const est = tracker.estimateEmbed({ model: 'text-embedding-005', tokens: 10_000 });
    expect(est).toBeCloseTo(2.625e-4, 7);
  });

  it('precheck: under budget → allowed=true', async () => {
    const db = makeMemoryDb();
    const tracker = createCostTracker({
      db,
      dailyLimitUsd: 5.0,
      now: () => FIXED_NOW,
    });
    const r = await tracker.precheck({ userId: USER_A, estimatedUsd: 0.01 });
    expect(r.allowed).toBe(true);
    expect(r.spentUsd).toBe(0);
    expect(r.remainingUsd).toBeCloseTo(4.99, 4);
    expect(r.softLimitReached).toBe(false);
    expect(r.reason).toBeUndefined();
  });

  it('precheck: over budget → allowed=false with reason', async () => {
    const db = makeMemoryDb();
    const tracker = createCostTracker({
      db,
      dailyLimitUsd: 1.0,
      now: () => FIXED_NOW,
    });
    // Pre-populate $0.95 spent
    db.rows.push({
      user_id: USER_A,
      date: FIXED_DATE,
      provider: 'vertex',
      model: 'gemini-2.0-flash-exp',
      prompt_tokens: 0,
      completion_tokens: 0,
      embedding_tokens: 0,
      total_usd: 0.95,
      call_count: 1,
      request_id: null,
      created_at: FIXED_NOW - 1000,
    });
    const r = await tracker.precheck({ userId: USER_A, estimatedUsd: 0.10 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('daily_limit_exhausted');
    expect(r.spentUsd).toBeCloseTo(0.95, 4);
  });

  it('precheck: soft-limit flag at 80%', async () => {
    const db = makeMemoryDb();
    const tracker = createCostTracker({
      db,
      dailyLimitUsd: 5.0,
      softLimitFraction: 0.8,
      now: () => FIXED_NOW,
    });
    db.rows.push({
      user_id: USER_A,
      date: FIXED_DATE,
      provider: 'vertex',
      model: 'gemini-2.0-flash-exp',
      prompt_tokens: 0,
      completion_tokens: 0,
      embedding_tokens: 0,
      total_usd: 3.5,
      call_count: 1,
      request_id: null,
      created_at: FIXED_NOW - 1000,
    });
    const r = await tracker.precheck({ userId: USER_A, estimatedUsd: 0.6 });
    // 3.5 + 0.6 = 4.1 >= 4.0 (80% of 5)
    expect(r.allowed).toBe(true);
    expect(r.softLimitReached).toBe(true);
  });

  it('record + getDaily roundtrip', async () => {
    const db = makeMemoryDb();
    const tracker = createCostTracker({ db, now: () => FIXED_NOW });

    await tracker.record({
      userId: USER_A,
      provider: 'vertex',
      model: 'gemini-2.0-flash-exp',
      promptTokens: 100,
      completionTokens: 50,
      totalUsd: 0.000_03,
    });
    await tracker.record({
      userId: USER_A,
      provider: 'vertex',
      model: 'text-embedding-005',
      embeddingTokens: 500,
      totalUsd: 0.000_012_5,
    });
    await tracker.record({
      userId: USER_B,
      provider: 'vertex',
      model: 'gemini-2.0-flash-exp',
      promptTokens: 200,
      completionTokens: 100,
      totalUsd: 0.000_06,
    });

    const dailyA = await tracker.getDaily({ userId: USER_A });
    expect(dailyA.date).toBe(FIXED_DATE);
    expect(dailyA.totalUsd).toBeCloseTo(0.000_042_5, 8);
    expect(dailyA.calls).toBe(2);

    const dailyB = await tracker.getDaily({ userId: USER_B });
    expect(dailyB.totalUsd).toBeCloseTo(0.000_06, 8);
    expect(dailyB.calls).toBe(1);
  });

  it('getDaily for explicit older date returns 0 if no rows', async () => {
    const db = makeMemoryDb();
    const tracker = createCostTracker({ db, now: () => FIXED_NOW });
    await tracker.record({
      userId: USER_A,
      provider: 'vertex',
      model: 'gemini-2.0-flash-exp',
      promptTokens: 1,
      completionTokens: 1,
      totalUsd: 0.001,
    });
    const old = await tracker.getDaily({ userId: USER_A, date: '2026-01-01' });
    expect(old.totalUsd).toBe(0);
    expect(old.calls).toBe(0);
  });

  it('record stores per-user/per-day with correct UTC date', async () => {
    const db = makeMemoryDb();
    // 23:30 UTC vs midnight: ensure date is computed via UTC, not local TZ.
    const ts = Date.parse('2026-05-13T23:30:00Z');
    const tracker = createCostTracker({ db, now: () => ts });
    await tracker.record({
      userId: USER_A,
      provider: 'vertex',
      model: 'gemini-2.0-flash-exp',
      promptTokens: 1,
      completionTokens: 1,
      totalUsd: 0.01,
    });
    expect(db.rows[0]?.date).toBe('2026-05-13');
  });
});
