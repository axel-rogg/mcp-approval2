/**
 * Unit-Tests fuer bootstrapIfNeeded (SEC-008).
 *
 * Wir mocken den DbAdapter mit handcoded SQL-Pattern-Matching analog zu
 * approvals.test.ts. Scope: Email-Gate, unique_violation-Mapping,
 * Backward-Compat (kein BOOTSTRAP_ADMIN_EMAIL).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DbAdapter, ScopedDb, RawDb, TransactionCtx } from '@mcp-approval2/adapters';
import { bootstrapIfNeeded } from './bootstrap.js';

interface UserRow {
  id: string;
  external_id: string;
  email: string;
  display_name: string;
  role: 'admin' | 'member';
  status: 'active' | 'suspended';
}

function makeStubDb(opts: {
  /** Wenn true: 1. INSERT wirft unique_violation. */
  uniqueViolation?: boolean;
  /** Pre-existing user count (signals "bootstrap already done"). */
  seedUserCount?: number;
} = {}): DbAdapter & { _users: UserRow[]; _audit: unknown[] } {
  const users: UserRow[] = [];
  const audit: unknown[] = [];
  if (opts.seedUserCount) {
    for (let i = 0; i < opts.seedUserCount; i++) {
      users.push({
        id: `seed-${i}`,
        external_id: `ext-${i}`,
        email: `existing${i}@example.com`,
        display_name: `Seed ${i}`,
        role: 'admin',
        status: 'active',
      });
    }
  }
  const exec = async <T = unknown>(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<T[]> => {
    const t = sql.replace(/\s+/g, ' ').trim();
    if (t.startsWith('SELECT COUNT(*)::int AS count FROM users WHERE status')) {
      return [{ count: users.filter((u) => u.status === 'active').length }] as unknown as T[];
    }
    if (t.startsWith('INSERT INTO users')) {
      if (opts.uniqueViolation) {
        const err = new Error('duplicate key value violates unique constraint') as Error & {
          code: string;
        };
        err.code = '23505';
        throw err;
      }
      const row: UserRow = {
        id: `user-${users.length + 1}`,
        external_id: String(params[0]),
        email: String(params[1]),
        display_name: String(params[2]),
        role: 'admin',
        status: 'active',
      };
      users.push(row);
      return [{ id: row.id }] as unknown as T[];
    }
    if (t.startsWith('INSERT INTO audit_log')) {
      audit.push(params);
      return [] as unknown as T[];
    }
    return [] as unknown as T[];
  };
  const raw: RawDb = {
    dialect: 'postgres',
    drizzle: {},
    query: exec,
  };
  const scoped: ScopedDb = {
    userId: 'stub',
    dialect: 'postgres',
    drizzle: {},
    query: exec,
  };
  return {
    dialect: 'postgres',
    _users: users,
    _audit: audit,
    async scoped() {
      return scoped;
    },
    unsafe() {
      return raw;
    },
    async transaction<T>(_uid: string, fn: (tx: ScopedDb, ctx: TransactionCtx) => Promise<T>) {
      return fn(scoped, { userId: 'stub', dialect: 'postgres' });
    },
    async migrate() {},
    async close() {},
  };
}

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe('bootstrapIfNeeded — SEC-008', () => {
  const input = {
    externalId: 'google|123',
    email: 'Operator@example.COM',
    displayName: 'The Operator',
  };

  it('happy-path: empty DB + matching BOOTSTRAP_ADMIN_EMAIL → admin', async () => {
    const db = makeStubDb();
    const result = await bootstrapIfNeeded(db, input, {
      BOOTSTRAP_ADMIN_EMAIL: 'operator@example.com',
    });
    expect(result.role).toBe('admin');
    expect(result.bootstrapped).toBe(true);
    expect(db._users).toHaveLength(1);
    expect(db._users[0]!.email).toBe('operator@example.com');
  });

  it('SEC-008: email mismatch → 403 + audit "rejected"', async () => {
    const db = makeStubDb();
    await expect(
      bootstrapIfNeeded(db, input, { BOOTSTRAP_ADMIN_EMAIL: 'other@example.com' }),
    ).rejects.toMatchObject({ status: 403, code: 'bootstrap_only' });
    expect(db._users).toHaveLength(0);
    // Audit-Trail: rejected-event sollte enqueued sein.
    const actions = db._audit.map((p) => (p as ReadonlyArray<unknown>)[3]);
    expect(actions).toContain('admin.bootstrap.rejected');
  });

  it('SEC-008: race-lost (unique_violation 23505) → 403 + audit', async () => {
    const db = makeStubDb({ uniqueViolation: true });
    await expect(
      bootstrapIfNeeded(db, input, { BOOTSTRAP_ADMIN_EMAIL: 'operator@example.com' }),
    ).rejects.toMatchObject({ status: 403, code: 'bootstrap_only' });
    const actions = db._audit.map((p) => (p as ReadonlyArray<unknown>)[3]);
    expect(actions).toContain('admin.bootstrap.rejected');
  });

  it('SEC-008: count > 0 → 403 (bootstrap already done)', async () => {
    const db = makeStubDb({ seedUserCount: 1 });
    await expect(
      bootstrapIfNeeded(db, input, { BOOTSTRAP_ADMIN_EMAIL: 'operator@example.com' }),
    ).rejects.toMatchObject({ status: 403, code: 'bootstrap_only' });
  });

  it('Backward-compat: no BOOTSTRAP_ADMIN_EMAIL in dev → console.warn + accept any email', async () => {
    const db = makeStubDb();
    const result = await bootstrapIfNeeded(db, input);
    expect(result.role).toBe('admin');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('BOOTSTRAP_ADMIN_EMAIL is not set'),
    );
  });

  it('Family-Hardening: no BOOTSTRAP_ADMIN_EMAIL in production → 403 + audit', async () => {
    const db = makeStubDb();
    await expect(
      bootstrapIfNeeded(db, input, { NODE_ENV: 'production' }),
    ).rejects.toMatchObject({ status: 403, code: 'bootstrap_only' });
    expect(db._users).toHaveLength(0);
    const actions = db._audit.map((p) => (p as ReadonlyArray<unknown>)[3]);
    expect(actions).toContain('admin.bootstrap.rejected');
  });

  it('Email comparison is case-insensitive + trimmed', async () => {
    const db = makeStubDb();
    const result = await bootstrapIfNeeded(
      db,
      { ...input, email: '  OPERATOR@example.COM  ' },
      { BOOTSTRAP_ADMIN_EMAIL: 'operator@example.com' },
    );
    expect(result.role).toBe('admin');
  });
});
