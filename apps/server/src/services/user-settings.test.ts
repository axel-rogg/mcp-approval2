/**
 * Unit-Tests fuer UserSettingsService (Phase E).
 *
 * Plan-Ref: PLAN-tool-defaults-v2.md (Phase E).
 */
import { describe, expect, it } from 'vitest';
import type {
  DbAdapter,
  RawDb,
  ScopedDb,
  TransactionCtx,
} from '@mcp-approval2/adapters';
import { HttpError } from '../lib/errors.js';
import {
  SETTING_ELICIT_ON_MISSING_DEFAULTS,
  createUserSettingsService,
} from './user-settings.js';

interface Row {
  user_id: string;
  key: string;
  value: unknown;
  updated_at: number;
}

function makeMemoryDb(seed: ReadonlyArray<Row> = []): DbAdapter {
  const rows: Row[] = seed.map((r) => ({ ...r }));

  function exec<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): T[] {
    const t = sql.replace(/\s+/g, ' ').trim();

    if (t.startsWith('SELECT user_id, key, value, updated_at')) {
      const [uid, key] = params as readonly unknown[];
      return rows
        .filter((r) => r.user_id === uid && (key === undefined || r.key === key))
        .map((r) => ({ ...r })) as unknown as T[];
    }

    if (t.startsWith('INSERT INTO user_settings')) {
      const [uid, key, valueJson, ts] = params as readonly unknown[];
      const parsed = JSON.parse(String(valueJson));
      const idx = rows.findIndex((r) => r.user_id === uid && r.key === key);
      const newRow: Row = {
        user_id: String(uid),
        key: String(key),
        value: parsed,
        updated_at: Number(ts),
      };
      if (idx >= 0) rows[idx] = newRow;
      else rows.push(newRow);
      return [newRow] as unknown as T[];
    }

    if (t.startsWith('DELETE FROM user_settings')) {
      const [uid, key] = params as readonly unknown[];
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (!r) continue;
        if (r.user_id === uid && r.key === key) rows.splice(i, 1);
      }
      return [] as unknown as T[];
    }

    return [] as unknown as T[];
  }

  const scoped: ScopedDb = {
    async query<T>(sql: string, params?: ReadonlyArray<unknown>): Promise<T[]> {
      return exec<T>(sql, params ?? []);
    },
  } as unknown as ScopedDb;

  return {
    async scoped<T>(_u: string, fn: (s: ScopedDb) => Promise<T>): Promise<T> {
      return fn(scoped);
    },
    async transaction<T>(
      _u: string,
      fn: (s: ScopedDb, tx: TransactionCtx) => Promise<T>,
    ): Promise<T> {
      const tx: TransactionCtx = { rollback: async () => {} } as unknown as TransactionCtx;
      return fn(scoped, tx);
    },
    async raw<T>(_fn: (db: RawDb) => Promise<T>): Promise<T> {
      throw new Error('raw not implemented');
    },
    async close(): Promise<void> {},
  } as unknown as DbAdapter;
}

describe('UserSettingsService', () => {
  it('set + get roundtrip', async () => {
    const svc = createUserSettingsService({ db: makeMemoryDb() });
    await svc.set('u1', SETTING_ELICIT_ON_MISSING_DEFAULTS, true);
    const entry = await svc.get('u1', SETTING_ELICIT_ON_MISSING_DEFAULTS);
    expect(entry?.value).toBe(true);
  });

  it('getBoolean returns fallback when not set', async () => {
    const svc = createUserSettingsService({ db: makeMemoryDb() });
    expect(await svc.getBoolean('u1', SETTING_ELICIT_ON_MISSING_DEFAULTS, false)).toBe(false);
  });

  it('getBoolean returns stored value', async () => {
    const svc = createUserSettingsService({ db: makeMemoryDb() });
    await svc.set('u1', SETTING_ELICIT_ON_MISSING_DEFAULTS, true);
    expect(await svc.getBoolean('u1', SETTING_ELICIT_ON_MISSING_DEFAULTS, false)).toBe(true);
  });

  it('rejects invalid key slug', async () => {
    const svc = createUserSettingsService({ db: makeMemoryDb() });
    await expect(svc.set('u1', 'INVALID Key', 'x')).rejects.toBeInstanceOf(HttpError);
  });

  it('isolates users', async () => {
    const svc = createUserSettingsService({ db: makeMemoryDb() });
    await svc.set('alice', SETTING_ELICIT_ON_MISSING_DEFAULTS, true);
    expect(
      await svc.getBoolean('bob', SETTING_ELICIT_ON_MISSING_DEFAULTS, false),
    ).toBe(false);
  });
});
