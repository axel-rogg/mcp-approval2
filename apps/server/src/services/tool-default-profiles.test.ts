/**
 * Unit-Tests fuer ToolDefaultProfilesService (Phase C).
 *
 * Plan-Ref: PLAN-tool-defaults-v2.md (Phase C).
 *
 * Scope:
 *   - CRUD: list / create / activate / delete
 *   - activate-Konflikt: zwei active Profile gleichzeitig (geht nicht — partial-
 *     unique-Index in 0028 + atomar in TX)
 *   - delete-Refuse wenn aktiv
 *   - copyFrom: Defaults werden mitkopiert
 *   - Per-User-Isolation: Alice's Profile sind in Bobs Sicht nicht da
 */
import { describe, expect, it } from 'vitest';
import type {
  DbAdapter,
  RawDb,
  ScopedDb,
  TransactionCtx,
} from '@mcp-approval2/adapters';
import { HttpError } from '../lib/errors.js';
import { createToolDefaultProfilesService } from './tool-default-profiles.js';

interface ProfileRow {
  user_id: string;
  sub_mcp_name: string;
  profile_name: string;
  description: string;
  is_active: boolean;
  created_at: number;
  updated_at: number;
}

interface DefaultRow {
  user_id: string;
  sub_mcp_name: string;
  profile_name: string;
  tool_name: string;
  field_name: string;
  value_text: string;
  value_json: unknown;
  value_kind: string;
  is_secret: boolean;
  orphan_since: number | null;
  created_at: number;
  updated_at: number;
}

function makeMemoryDb(
  profileSeed: ReadonlyArray<ProfileRow> = [],
  defaultsSeed: ReadonlyArray<DefaultRow> = [],
): DbAdapter {
  const profiles: ProfileRow[] = profileSeed.map((p) => ({ ...p }));
  const defaults: DefaultRow[] = defaultsSeed.map((d) => ({ ...d }));

  function pKey(p: Pick<ProfileRow, 'user_id' | 'sub_mcp_name' | 'profile_name'>): string {
    return `${p.user_id}|${p.sub_mcp_name}|${p.profile_name}`;
  }

  function exec<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): T[] {
    const t = sql.replace(/\s+/g, ' ').trim();

    if (t.startsWith('SELECT user_id, sub_mcp_name, profile_name, description, is_active')) {
      const [uid, sub] = params as readonly unknown[];
      // optional name filter
      const profileName = params[2] as string | undefined;
      // optional is_active filter
      const onlyActive = /is_active = TRUE/.test(t);
      return profiles
        .filter(
          (p) =>
            p.user_id === uid &&
            p.sub_mcp_name === sub &&
            (profileName === undefined || p.profile_name === profileName) &&
            (!onlyActive || p.is_active),
        )
        .map((p) => ({ ...p })) as unknown as T[];
    }

    if (t.startsWith('SELECT 1 AS exists FROM user_tool_default_profiles')) {
      const [uid, sub, name] = params as readonly unknown[];
      const found = profiles.some(
        (p) => p.user_id === uid && p.sub_mcp_name === sub && p.profile_name === name,
      );
      return (found ? [{ exists: true }] : []) as unknown as T[];
    }

    if (t.startsWith('SELECT profile_name FROM user_tool_default_profiles')) {
      const [uid, sub, name] = params as readonly unknown[];
      return profiles
        .filter((p) => p.user_id === uid && p.sub_mcp_name === sub && p.profile_name === name)
        .map((p) => ({ profile_name: p.profile_name })) as unknown as T[];
    }

    if (t.startsWith('SELECT is_active FROM user_tool_default_profiles')) {
      const [uid, sub, name] = params as readonly unknown[];
      return profiles
        .filter((p) => p.user_id === uid && p.sub_mcp_name === sub && p.profile_name === name)
        .map((p) => ({ is_active: p.is_active })) as unknown as T[];
    }

    if (t.startsWith('INSERT INTO user_tool_default_profiles')) {
      const [uid, sub, name, desc, ts] = params as readonly unknown[];
      const row: ProfileRow = {
        user_id: String(uid),
        sub_mcp_name: String(sub),
        profile_name: String(name),
        description: String(desc),
        is_active: false,
        created_at: Number(ts),
        updated_at: Number(ts),
      };
      profiles.push(row);
      return [row] as unknown as T[];
    }

    if (t.startsWith('UPDATE user_tool_default_profiles SET is_active = FALSE')) {
      const [ts, uid, sub] = params as readonly unknown[];
      for (const p of profiles) {
        if (p.user_id === uid && p.sub_mcp_name === sub && p.is_active) {
          p.is_active = false;
          p.updated_at = Number(ts);
        }
      }
      return [] as unknown as T[];
    }

    if (t.startsWith('UPDATE user_tool_default_profiles SET is_active = TRUE')) {
      const [ts, uid, sub, name] = params as readonly unknown[];
      for (const p of profiles) {
        if (p.user_id === uid && p.sub_mcp_name === sub && p.profile_name === name) {
          p.is_active = true;
          p.updated_at = Number(ts);
        }
      }
      return [] as unknown as T[];
    }

    if (t.startsWith('INSERT INTO user_server_tool_defaults')) {
      // copyFrom-SELECT-INSERT — wir simulieren via Filter+map.
      const [uid, sub, srcProfile, dstProfile, ts] = params as readonly unknown[];
      const toCopy = defaults.filter(
        (d) => d.user_id === uid && d.sub_mcp_name === sub && d.profile_name === srcProfile,
      );
      for (const d of toCopy) {
        defaults.push({
          ...d,
          profile_name: String(dstProfile),
          orphan_since: null,
          created_at: Number(ts),
          updated_at: Number(ts),
        });
      }
      return [] as unknown as T[];
    }

    if (t.startsWith('DELETE FROM user_server_tool_defaults')) {
      const [uid, sub, name] = params as readonly unknown[];
      for (let i = defaults.length - 1; i >= 0; i--) {
        const d = defaults[i];
        if (!d) continue;
        if (d.user_id === uid && d.sub_mcp_name === sub && d.profile_name === name) {
          defaults.splice(i, 1);
        }
      }
      return [] as unknown as T[];
    }

    if (t.startsWith('DELETE FROM user_tool_default_profiles')) {
      const [uid, sub, name] = params as readonly unknown[];
      for (let i = profiles.length - 1; i >= 0; i--) {
        const p = profiles[i];
        if (!p) continue;
        if (p.user_id === uid && p.sub_mcp_name === sub && p.profile_name === name) {
          profiles.splice(i, 1);
        }
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
    async scoped<T>(_uid: string, fn: (s: ScopedDb) => Promise<T>): Promise<T> {
      return fn(scoped);
    },
    async transaction<T>(
      _uid: string,
      fn: (s: ScopedDb, tx: TransactionCtx) => Promise<T>,
    ): Promise<T> {
      const tx: TransactionCtx = { rollback: async () => {} } as unknown as TransactionCtx;
      return fn(scoped, tx);
    },
    async raw<T>(_fn: (db: RawDb) => Promise<T>): Promise<T> {
      throw new Error('raw not implemented in mock');
    },
    async close(): Promise<void> {},
    _profiles: profiles,
    _defaults: defaults,
  } as unknown as DbAdapter;
  // explicit cast above means tests can poke `_profiles` for assertions
}

describe('ToolDefaultProfilesService — CRUD', () => {
  it('list returns empty when no profiles', async () => {
    const svc = createToolDefaultProfilesService({ db: makeMemoryDb() });
    const list = await svc.list('u1', 'gws');
    expect(list).toEqual([]);
  });

  it('create + list + activate roundtrip', async () => {
    const svc = createToolDefaultProfilesService({ db: makeMemoryDb() });
    await svc.create({ userId: 'u1', subMcpName: 'db', profileName: 'prod' });
    await svc.create({ userId: 'u1', subMcpName: 'db', profileName: 'test' });
    let list = await svc.list('u1', 'db');
    expect(list.map((p) => p.profileName).sort()).toEqual(['prod', 'test']);
    expect(list.every((p) => !p.isActive)).toBe(true);
    await svc.activate('u1', 'db', 'prod');
    list = await svc.list('u1', 'db');
    const prod = list.find((p) => p.profileName === 'prod');
    const test = list.find((p) => p.profileName === 'test');
    expect(prod?.isActive).toBe(true);
    expect(test?.isActive).toBe(false);
  });

  it('activate flips atomically — only one active at a time', async () => {
    const svc = createToolDefaultProfilesService({ db: makeMemoryDb() });
    await svc.create({ userId: 'u1', subMcpName: 'db', profileName: 'prod', activate: true });
    await svc.create({ userId: 'u1', subMcpName: 'db', profileName: 'test' });
    await svc.activate('u1', 'db', 'test');
    const list = await svc.list('u1', 'db');
    const actives = list.filter((p) => p.isActive);
    expect(actives).toHaveLength(1);
    expect(actives[0]?.profileName).toBe('test');
  });

  it('rejects creation with conflicting name', async () => {
    const svc = createToolDefaultProfilesService({ db: makeMemoryDb() });
    await svc.create({ userId: 'u1', subMcpName: 'db', profileName: 'prod' });
    await expect(
      svc.create({ userId: 'u1', subMcpName: 'db', profileName: 'prod' }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it('rejects invalid profile-name slug', async () => {
    const svc = createToolDefaultProfilesService({ db: makeMemoryDb() });
    await expect(
      svc.create({ userId: 'u1', subMcpName: 'db', profileName: 'INVALID Name' }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it('rejects activate of non-existent profile', async () => {
    const svc = createToolDefaultProfilesService({ db: makeMemoryDb() });
    await expect(svc.activate('u1', 'db', 'ghost')).rejects.toBeInstanceOf(HttpError);
  });

  it('rejects delete of active profile', async () => {
    const svc = createToolDefaultProfilesService({ db: makeMemoryDb() });
    await svc.create({ userId: 'u1', subMcpName: 'db', profileName: 'prod', activate: true });
    await expect(svc.delete('u1', 'db', 'prod')).rejects.toBeInstanceOf(HttpError);
  });

  it('allows delete of inactive profile', async () => {
    const svc = createToolDefaultProfilesService({ db: makeMemoryDb() });
    await svc.create({ userId: 'u1', subMcpName: 'db', profileName: 'prod', activate: true });
    await svc.create({ userId: 'u1', subMcpName: 'db', profileName: 'test' });
    await svc.delete('u1', 'db', 'test');
    const list = await svc.list('u1', 'db');
    expect(list.map((p) => p.profileName)).toEqual(['prod']);
  });

  it('copyFrom duplicates defaults into new profile', async () => {
    const db = makeMemoryDb(
      [
        {
          user_id: 'u1',
          sub_mcp_name: 'db',
          profile_name: 'prod',
          description: '',
          is_active: true,
          created_at: 1,
          updated_at: 1,
        },
      ],
      [
        {
          user_id: 'u1',
          sub_mcp_name: 'db',
          profile_name: 'prod',
          tool_name: 'db.query',
          field_name: 'connection_string',
          value_text: 'postgres://prod',
          value_json: 'postgres://prod',
          value_kind: 'text',
          is_secret: false,
          orphan_since: null,
          created_at: 1,
          updated_at: 1,
        },
      ],
    );
    const svc = createToolDefaultProfilesService({ db });
    await svc.create({
      userId: 'u1',
      subMcpName: 'db',
      profileName: 'test',
      copyFrom: 'prod',
    });
    // Pruefe via internem mock-state: defaults haben jetzt 2 Rows, eine pro Profil.
    const inner = (db as unknown as { _defaults: DefaultRow[] })._defaults;
    expect(inner).toHaveLength(2);
    const testRow = inner.find((d) => d.profile_name === 'test');
    expect(testRow?.value_text).toBe('postgres://prod');
  });

  it('rejects copyFrom of missing source', async () => {
    const svc = createToolDefaultProfilesService({ db: makeMemoryDb() });
    await expect(
      svc.create({
        userId: 'u1',
        subMcpName: 'db',
        profileName: 'test',
        copyFrom: 'ghost',
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it('isolates users (Alice profiles invisible to Bob)', async () => {
    const svc = createToolDefaultProfilesService({ db: makeMemoryDb() });
    await svc.create({ userId: 'alice', subMcpName: 'db', profileName: 'prod' });
    const bobList = await svc.list('bob', 'db');
    expect(bobList).toEqual([]);
    // Bob kann nicht aktivieren was er nicht sieht.
    await expect(svc.activate('bob', 'db', 'prod')).rejects.toBeInstanceOf(HttpError);
  });

  it('activeProfileNameFor returns "default" when no active profile', async () => {
    const svc = createToolDefaultProfilesService({ db: makeMemoryDb() });
    expect(await svc.activeProfileNameFor('u1', 'db')).toBe('default');
  });

  it('activeProfileNameFor returns the active profile name', async () => {
    const svc = createToolDefaultProfilesService({ db: makeMemoryDb() });
    await svc.create({ userId: 'u1', subMcpName: 'db', profileName: 'prod', activate: true });
    expect(await svc.activeProfileNameFor('u1', 'db')).toBe('prod');
  });
});
