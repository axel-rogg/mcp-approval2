/**
 * Unit-Tests fuer UserServerToolDefaultsService (Phase B).
 *
 * Plan-Ref: PLAN-tool-defaults-v2.md Phase B.
 *
 * Scope:
 *   - typed set() mit number/boolean/json
 *   - assertTypeMatchesKind: Mismatch wirft 400
 *   - Secret-Soft-Block (Plan-Entscheidung ④): _api_key etc. wird abgelehnt
 *   - Profile-Filter beim listByTool
 *   - markOrphan setzt + unset
 */
import { describe, expect, it } from 'vitest';
import type {
  DbAdapter,
  RawDb,
  ScopedDb,
  TransactionCtx,
} from '@mcp-approval2/adapters';
import { HttpError } from '../lib/errors.js';
import { createUserServerToolDefaultsService } from './user-server-tool-defaults.js';

interface Row {
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

function makeMemoryDb(seed: ReadonlyArray<Row> = []): DbAdapter {
  const rows: Row[] = seed.map((r) => ({ ...r }));

  function key(r: Pick<Row, 'user_id' | 'sub_mcp_name' | 'profile_name' | 'tool_name' | 'field_name'>): string {
    return `${r.user_id}|${r.sub_mcp_name}|${r.profile_name}|${r.tool_name}|${r.field_name}`;
  }

  function exec<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): T[] {
    const t = sql.replace(/\s+/g, ' ').trim();

    if (t.startsWith('INSERT INTO user_server_tool_defaults')) {
      const [uid, sub, profile, tool, field, valueText, valueJsonStr, kind, isSecret, ts] =
        params as readonly unknown[];
      const newRow: Row = {
        user_id: String(uid),
        sub_mcp_name: String(sub),
        profile_name: String(profile),
        tool_name: String(tool),
        field_name: String(field),
        value_text: String(valueText),
        value_json: JSON.parse(String(valueJsonStr)),
        value_kind: String(kind),
        is_secret: Boolean(isSecret),
        orphan_since: null,
        created_at: Number(ts),
        updated_at: Number(ts),
      };
      const idx = rows.findIndex((r) => key(r) === key(newRow));
      if (idx >= 0) rows[idx] = newRow;
      else rows.push(newRow);
      return [newRow] as unknown as T[];
    }

    if (t.startsWith('SELECT user_id, sub_mcp_name, profile_name')) {
      // listByTool / listByServer
      const [uid, sub] = params as readonly unknown[];
      const tool = params[2] as string | undefined;
      const profile = params[3] as string | undefined;
      return rows
        .filter(
          (r) =>
            r.user_id === uid &&
            r.sub_mcp_name === sub &&
            (tool === undefined || r.tool_name === tool) &&
            (profile === undefined || r.profile_name === profile),
        )
        .map((r) => ({ ...r })) as unknown as T[];
    }

    if (t.startsWith('DELETE FROM user_server_tool_defaults')) {
      // params order varies by overload — match by row count.
      const [uid, sub] = params as readonly unknown[];
      const profile = params[2] as string | undefined;
      const tool = params[3] as string | undefined;
      const field = params[4] as string | undefined;
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (!r) continue;
        if (r.user_id !== uid || r.sub_mcp_name !== sub) continue;
        if (profile !== undefined && r.profile_name !== profile) continue;
        if (tool !== undefined && r.tool_name !== tool) continue;
        if (field !== undefined && r.field_name !== field) continue;
        rows.splice(i, 1);
      }
      return [] as unknown as T[];
    }

    if (t.startsWith('UPDATE user_server_tool_defaults')) {
      const [orphan, uid, sub, profile, tool, field] = params as readonly unknown[];
      for (const r of rows) {
        if (
          r.user_id === uid &&
          r.sub_mcp_name === sub &&
          r.profile_name === profile &&
          r.tool_name === tool &&
          r.field_name === field
        ) {
          r.orphan_since = orphan as number | null;
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
  } as unknown as DbAdapter;
}

describe('UserServerToolDefaultsService.set (Phase B)', () => {
  it('persists a number value with valueKind=number', async () => {
    const svc = createUserServerToolDefaultsService({ db: makeMemoryDb() });
    const out = await svc.set({
      userId: 'u1',
      subMcpName: 'gws',
      toolName: 'gws.calendar.list',
      fieldName: 'max_results',
      value: 25,
      valueKind: 'number',
    });
    expect(out.value).toBe(25);
    expect(out.valueKind).toBe('number');
    expect(out.profileName).toBe('default');
  });

  it('persists a boolean value with valueKind=boolean', async () => {
    const svc = createUserServerToolDefaultsService({ db: makeMemoryDb() });
    const out = await svc.set({
      userId: 'u1',
      subMcpName: 'db',
      toolName: 'db.query',
      fieldName: 'read_only',
      value: true,
      valueKind: 'boolean',
    });
    expect(out.value).toBe(true);
    expect(out.valueKind).toBe('boolean');
  });

  it('infers valueKind from value if not provided', async () => {
    const svc = createUserServerToolDefaultsService({ db: makeMemoryDb() });
    const numOut = await svc.set({
      userId: 'u1',
      subMcpName: 'gws',
      toolName: 'gws.calendar.list',
      fieldName: 'max_results',
      value: 42,
    });
    expect(numOut.valueKind).toBe('number');

    const boolOut = await svc.set({
      userId: 'u1',
      subMcpName: 'gws',
      toolName: 'gws.calendar.list',
      fieldName: 'show_all',
      value: false,
    });
    expect(boolOut.valueKind).toBe('boolean');
  });

  it('rejects type/kind mismatch (number expected, string given)', async () => {
    const svc = createUserServerToolDefaultsService({ db: makeMemoryDb() });
    await expect(
      svc.set({
        userId: 'u1',
        subMcpName: 'gws',
        toolName: 'gws.calendar.list',
        fieldName: 'max_results',
        value: 'not a number',
        valueKind: 'number',
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it('rejects invalid profile name', async () => {
    const svc = createUserServerToolDefaultsService({ db: makeMemoryDb() });
    await expect(
      svc.set({
        userId: 'u1',
        subMcpName: 'gws',
        profileName: 'INVALID-Profile-Name',
        toolName: 'gws.calendar.list',
        fieldName: 'max_results',
        value: 25,
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it('rejects fields with secret-looking names (Plan §10 ④)', async () => {
    const svc = createUserServerToolDefaultsService({ db: makeMemoryDb() });
    for (const field of ['api_key', 'auth_token', 'client_secret', 'admin_password']) {
      await expect(
        svc.set({
          userId: 'u1',
          subMcpName: 'gws',
          toolName: 'gws.calendar.list',
          fieldName: field,
          value: 'plaintext-here',
          valueKind: 'text',
        }),
      ).rejects.toBeInstanceOf(HttpError);
    }
  });

  it('allows non-secret-looking text fields', async () => {
    const svc = createUserServerToolDefaultsService({ db: makeMemoryDb() });
    const out = await svc.set({
      userId: 'u1',
      subMcpName: 'gws',
      toolName: 'gws.calendar.list',
      fieldName: 'default_calendar',
      value: 'primary',
      valueKind: 'text',
    });
    expect(out.value).toBe('primary');
  });

  it('filters listByTool by profile when given', async () => {
    const svc = createUserServerToolDefaultsService({ db: makeMemoryDb() });
    await svc.set({
      userId: 'u1',
      subMcpName: 'db',
      profileName: 'prod',
      toolName: 'db.query',
      fieldName: 'connection_string',
      value: 'postgres://prod',
      valueKind: 'text',
    });
    await svc.set({
      userId: 'u1',
      subMcpName: 'db',
      profileName: 'test',
      toolName: 'db.query',
      fieldName: 'connection_string',
      value: 'postgres://localhost',
      valueKind: 'text',
    });
    const prodOnly = await svc.listByTool('u1', 'db', 'db.query', 'prod');
    expect(prodOnly).toHaveLength(1);
    expect(prodOnly[0]?.value).toBe('postgres://prod');
    const all = await svc.listByTool('u1', 'db', 'db.query');
    expect(all).toHaveLength(2);
  });

  it('markOrphan sets + unsets orphan_since', async () => {
    const svc = createUserServerToolDefaultsService({ db: makeMemoryDb() });
    await svc.set({
      userId: 'u1',
      subMcpName: 'gws',
      toolName: 'gws.calendar.list',
      fieldName: 'old_field',
      value: 'wert',
      valueKind: 'text',
    });
    await svc.markOrphan({
      userId: 'u1',
      subMcpName: 'gws',
      profileName: 'default',
      toolName: 'gws.calendar.list',
      fieldName: 'old_field',
      orphanSince: 123456789,
    });
    const list = await svc.listByTool('u1', 'gws', 'gws.calendar.list');
    expect(list[0]?.orphanSince).toBe(123456789);

    await svc.markOrphan({
      userId: 'u1',
      subMcpName: 'gws',
      profileName: 'default',
      toolName: 'gws.calendar.list',
      fieldName: 'old_field',
      orphanSince: null,
    });
    const list2 = await svc.listByTool('u1', 'gws', 'gws.calendar.list');
    expect(list2[0]?.orphanSince).toBeNull();
  });
});
