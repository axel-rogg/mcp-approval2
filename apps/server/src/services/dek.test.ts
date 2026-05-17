/**
 * Unit-Tests fuer DekService — roundtrip, idempotent-create, race-tolerance,
 * audit-emission, destroy-flow. Mocks: in-memory `user_dek_seeds`-Map + audit
 * collector + LocalKekProvider (real wrap/unwrap, just no real Vault).
 */
import { describe, expect, it, vi } from 'vitest';
import { LocalKekProvider } from '@mcp-approval2/adapters';
import type { DbAdapter, KekProvider, RawDb, ScopedDb, TransactionCtx } from '@mcp-approval2/adapters';
import { randomBytes } from '@mcp-approval2/core';
import { createDekService } from './dek.js';

interface SeedRow {
  user_id: string;
  wrapped_dek: Uint8Array;
  kek_ref: string;
  created_at: number;
  rotated_at: number | null;
}

interface AuditCall {
  readonly action: string;
  readonly result: string;
  readonly actorUserId: string | null;
  readonly details?: Record<string, unknown>;
  readonly requestId?: string;
}

function makeMemoryDb(): DbAdapter & {
  _seeds: Map<string, SeedRow>;
  _audit: AuditCall[];
} {
  const seeds = new Map<string, SeedRow>();
  const audit: AuditCall[] = [];

  function exec<T = unknown>(text: string, params: ReadonlyArray<unknown>): T[] {
    const t = text.replace(/\s+/g, ' ').trim();

    if (t.startsWith('SELECT user_id, wrapped_dek, kek_ref, created_at, rotated_at FROM user_dek_seeds')) {
      const userId = String(params[0]);
      const row = seeds.get(userId);
      return (row ? [row] : []) as unknown as T[];
    }

    if (t.startsWith('INSERT INTO user_dek_seeds')) {
      const [userId, wrapped, kekRef, createdAt] = params as readonly unknown[];
      const uid = String(userId);
      if (seeds.has(uid)) {
        // ON CONFLICT DO NOTHING → no row returned.
        return [] as unknown as T[];
      }
      const row: SeedRow = {
        user_id: uid,
        wrapped_dek: wrapped as Uint8Array,
        kek_ref: String(kekRef),
        created_at: Number(createdAt),
        rotated_at: null,
      };
      seeds.set(uid, row);
      return [row] as unknown as T[];
    }

    if (t.startsWith('UPDATE user_dek_seeds')) {
      const [wrapped, kekRef, rotatedAt, userId] = params as readonly unknown[];
      const row = seeds.get(String(userId));
      if (!row) return [] as unknown as T[];
      row.wrapped_dek = wrapped as Uint8Array;
      row.kek_ref = String(kekRef);
      row.rotated_at = Number(rotatedAt);
      return [{ user_id: row.user_id }] as unknown as T[];
    }

    if (t.startsWith('DELETE FROM user_dek_seeds')) {
      seeds.delete(String(params[0]));
      return [] as unknown as T[];
    }

    if (t.startsWith('INSERT INTO audit_log')) {
      // Schema-Match mit services/audit.ts:
      //   (ts, actor_user_id, actor_type, action, request_id, ip, user_agent, result, details)
      const [
        _ts,
        actorUserId,
        _actorType,
        action,
        requestId,
        _ip,
        _userAgent,
        result,
        details,
      ] = params as readonly unknown[];
      audit.push({
        action: String(action),
        result: String(result),
        actorUserId: actorUserId === null ? null : String(actorUserId),
        ...(typeof details === 'string'
          ? { details: JSON.parse(details) as Record<string, unknown> }
          : {}),
        ...(requestId ? { requestId: String(requestId) } : {}),
      });
      return [] as unknown as T[];
    }

    throw new Error(`unmocked SQL: ${t.slice(0, 100)}`);
  }

  const rawDb: RawDb = {
    dialect: 'postgres',
    drizzle: {},
    async query<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
      return exec<T>(sql, params);
    },
  };

  return {
    _seeds: seeds,
    _audit: audit,
    dialect: 'postgres',
    async scoped(userId: string): Promise<ScopedDb> {
      return {
        userId,
        dialect: 'postgres',
        drizzle: {},
        async query<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
          return exec<T>(sql, params);
        },
      };
    },
    unsafe(_reason: string): RawDb {
      return rawDb;
    },
    async transaction<T>(
      userId: string,
      fn: (tx: ScopedDb, ctx: TransactionCtx) => Promise<T>,
    ): Promise<T> {
      return fn(await this.scoped(userId), { userId, dialect: 'postgres' });
    },
    async migrate() {},
    async close() {},
  };
}

function makeKek(): KekProvider {
  return new LocalKekProvider({ masterKey: randomBytes(32) });
}

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

describe('DekService', () => {
  it('resolveUserDek: first call creates seed + returns 32-byte DEK', async () => {
    const db = makeMemoryDb();
    const svc = createDekService({ db, kekProvider: makeKek() });
    const dek = await svc.resolveUserDek({ userId: USER_A });
    expect(dek).toBeInstanceOf(Uint8Array);
    expect(dek.byteLength).toBe(32);
    expect(db._seeds.size).toBe(1);
    const created = db._audit.find((a) => a.action === 'dek.created');
    expect(created?.result).toBe('success');
    const resolved = db._audit.find((a) => a.action === 'dek.resolved');
    expect(resolved?.result).toBe('success');
  });

  it('resolveUserDek: idempotent — same DEK on repeat call', async () => {
    const db = makeMemoryDb();
    const svc = createDekService({ db, kekProvider: makeKek() });
    const a = await svc.resolveUserDek({ userId: USER_A });
    const b = await svc.resolveUserDek({ userId: USER_A });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    // Second call must NOT emit dek.created again.
    const creates = db._audit.filter((a) => a.action === 'dek.created');
    expect(creates).toHaveLength(1);
  });

  it('resolveUserDek: distinct DEKs per user', async () => {
    const db = makeMemoryDb();
    const svc = createDekService({ db, kekProvider: makeKek() });
    const a = await svc.resolveUserDek({ userId: USER_A });
    const b = await svc.resolveUserDek({ userId: USER_B });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('resolveUserDek: audit contains request_id when given', async () => {
    const db = makeMemoryDb();
    const svc = createDekService({ db, kekProvider: makeKek() });
    await svc.resolveUserDek({ userId: USER_A, requestId: 'req-abc' });
    const resolved = db._audit.find((a) => a.action === 'dek.resolved');
    expect(resolved?.requestId).toBe('req-abc');
  });

  it('resolveUserDek: audit details NEVER contain the DEK', async () => {
    const db = makeMemoryDb();
    const svc = createDekService({ db, kekProvider: makeKek() });
    const dek = await svc.resolveUserDek({ userId: USER_A });
    const dekHex = Buffer.from(dek).toString('hex');
    for (const a of db._audit) {
      const json = JSON.stringify(a);
      expect(json).not.toContain(dekHex);
    }
  });

  it('resolveUserDek: race — second writer falls back to first seed', async () => {
    const db = makeMemoryDb();
    // Inject a "lost the race" scenario: between readSeed-null and INSERT,
    // someone else writes. We simulate this by pre-populating the seed
    // BEFORE the insert ever runs — i.e. monkey-patch unsafe-query to plant
    // a row mid-flight.
    const kek = makeKek();
    const svc = createDekService({ db, kekProvider: kek });

    const planted: Uint8Array = await kek.wrap(randomBytes(32), `vault://transit/keys/user-dek-${USER_A}`);
    let firstSelectDone = false;
    const origUnsafe = db.unsafe.bind(db);
    db.unsafe = function (reason: string): ReturnType<typeof origUnsafe> {
      const raw = origUnsafe(reason);
      return {
        ...raw,
        async query<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
          if (
            !firstSelectDone &&
            sql.includes('SELECT user_id, wrapped_dek') &&
            String(params[0]) === USER_A
          ) {
            firstSelectDone = true;
            // Plant the row from "another worker" before returning the empty result.
            db._seeds.set(USER_A, {
              user_id: USER_A,
              wrapped_dek: planted,
              kek_ref: `vault://transit/keys/user-dek-${USER_A}`,
              created_at: Date.now() - 10,
              rotated_at: null,
            });
            return [] as unknown as T[];
          }
          return raw.query<T>(sql, params);
        },
      };
    };

    const dek = await svc.resolveUserDek({ userId: USER_A });
    expect(dek.byteLength).toBe(32);
    // Should be the planted DEK (unwrap of the planted blob), NOT a fresh random.
    const expected = await kek.unwrap(planted, `vault://transit/keys/user-dek-${USER_A}`);
    expect(Buffer.from(dek).equals(Buffer.from(expected))).toBe(true);
  });

  it('rotateUserDek: replaces seed + new DEK on resolve', async () => {
    const db = makeMemoryDb();
    const svc = createDekService({ db, kekProvider: makeKek() });
    const original = await svc.resolveUserDek({ userId: USER_A });
    await svc.rotateUserDek({ userId: USER_A });
    const rotated = await svc.resolveUserDek({ userId: USER_A });
    expect(Buffer.from(original).equals(Buffer.from(rotated))).toBe(false);
    expect(db._seeds.get(USER_A)?.rotated_at).toBeTypeOf('number');
  });

  it('rotateUserDek: throws when user has no seed yet', async () => {
    const db = makeMemoryDb();
    const svc = createDekService({ db, kekProvider: makeKek() });
    await expect(svc.rotateUserDek({ userId: USER_A })).rejects.toThrow(/not initialized|not_found/);
  });

  it('destroyUserDek: shreds + deletes row', async () => {
    const db = makeMemoryDb();
    const kek = makeKek();
    const destroySpy = vi.spyOn(kek, 'destroyKey');
    const svc = createDekService({ db, kekProvider: kek });
    await svc.resolveUserDek({ userId: USER_A });
    await svc.destroyUserDek({ userId: USER_A });
    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(db._seeds.has(USER_A)).toBe(false);
    expect(db._audit.find((a) => a.action === 'dek.destroyed')).toBeTruthy();
  });

  it('resolveUserDek: rejects empty userId', async () => {
    const db = makeMemoryDb();
    const svc = createDekService({ db, kekProvider: makeKek() });
    await expect(svc.resolveUserDek({ userId: '' })).rejects.toThrow();
  });

  it('resolveUserDek: failure path emits audit failure', async () => {
    const db = makeMemoryDb();
    const kek = makeKek();
    vi.spyOn(kek, 'wrap').mockRejectedValue(new Error('vault sealed'));
    const svc = createDekService({ db, kekProvider: kek });
    await expect(svc.resolveUserDek({ userId: USER_A })).rejects.toThrow(/vault sealed/);
    // services/audit.ts mapResult() maps 'failure' → 'error' damit der
    // audit_log_result_check Constraint passt (success|denied|error).
    const failure = db._audit.find(
      (a) => a.action === 'dek.resolved' && a.result === 'error',
    );
    expect(failure).toBeTruthy();
    expect((failure?.details as { error?: string } | undefined)?.error).toContain('vault sealed');
  });
});
