/**
 * Unit-Tests fuer PrefsService.
 *
 * Scope:
 *   - get / set / remove roundtrip
 *   - resolveForTool: user-args WIN, defaults fuellen Luecken
 *   - resolveForTool: scope-Hierarchie (session > user > tenant)
 *
 * Mocks: in-memory DbAdapter, der die `user_tool_prefs`-Tabelle als Map
 * keyed by `userId|toolName|field|scope` repraesentiert.
 */
import { describe, it, expect } from 'vitest';
import type {
  DbAdapter,
  ScopedDb,
  RawDb,
  TransactionCtx,
} from '@mcp-approval2/adapters';
import { createPrefsService } from './prefs.js';

interface Row {
  user_id: string;
  tool_name: string;
  field: string;
  value_json: unknown;
  scope: string;
  created_at: number;
  updated_at: number;
}

function makeMemoryDb(): DbAdapter & { _rows: Map<string, Row> } {
  const rows = new Map<string, Row>();

  function key(uid: string, t: string, f: string, s: string): string {
    return `${uid}|${t}|${f}|${s}`;
  }

  function exec<T = unknown>(text: string, params: ReadonlyArray<unknown> = []): T[] {
    const t = text.replace(/\s+/g, ' ').trim();

    if (t.startsWith('INSERT INTO user_tool_prefs')) {
      const [uid, tool, field, valueJson, scope, now] = params as readonly unknown[];
      const k = key(String(uid), String(tool), String(field), String(scope));
      const parsedValue = JSON.parse(String(valueJson));
      const existing = rows.get(k);
      if (existing) {
        existing.value_json = parsedValue;
        existing.updated_at = Number(now);
      } else {
        rows.set(k, {
          user_id: String(uid),
          tool_name: String(tool),
          field: String(field),
          value_json: parsedValue,
          scope: String(scope),
          created_at: Number(now),
          updated_at: Number(now),
        });
      }
      return [] as unknown as T[];
    }

    if (t.startsWith('DELETE FROM user_tool_prefs')) {
      const [uid, tool, field, scope] = params as readonly unknown[];
      rows.delete(key(String(uid), String(tool), String(field), String(scope)));
      return [] as unknown as T[];
    }

    if (t.startsWith('SELECT') && t.includes('FROM user_tool_prefs')) {
      const uid = String(params[0]);
      const toolFilter = params[1] !== undefined ? String(params[1]) : null;
      const fieldFilter = params[2] !== undefined ? String(params[2]) : null;
      const out: Row[] = [];
      for (const r of rows.values()) {
        if (r.user_id !== uid) continue;
        if (toolFilter !== null && r.tool_name !== toolFilter) continue;
        if (fieldFilter !== null && r.field !== fieldFilter) continue;
        out.push(r);
      }
      return out as unknown as T[];
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

  const raw: RawDb = {
    dialect: 'postgres',
    drizzle: {},
    async query<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
      return exec<T>(sql, params);
    },
  };

  return {
    dialect: 'postgres',
    _rows: rows,
    async scoped(userId: string) {
      return scoped(userId);
    },
    unsafe() {
      return raw;
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
}

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

describe('PrefsService', () => {
  it('set + get + remove roundtrip', async () => {
    const db = makeMemoryDb();
    const svc = createPrefsService({ db });

    await svc.set({
      userId: USER_A,
      toolName: 'gws:llm.ask',
      field: 'model',
      value: 'gemini-3-pro',
    });

    const got = await svc.get({ userId: USER_A });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      toolName: 'gws:llm.ask',
      field: 'model',
      value: 'gemini-3-pro',
      scope: 'user',
    });

    await svc.set({
      userId: USER_A,
      toolName: 'gws:llm.ask',
      field: 'temperature',
      value: 0.7,
    });
    const byTool = await svc.get({ userId: USER_A, toolName: 'gws:llm.ask' });
    expect(byTool).toHaveLength(2);

    const byField = await svc.get({
      userId: USER_A,
      toolName: 'gws:llm.ask',
      field: 'temperature',
    });
    expect(byField).toHaveLength(1);
    expect(byField[0]?.value).toBe(0.7);

    await svc.remove({
      userId: USER_A,
      toolName: 'gws:llm.ask',
      field: 'temperature',
    });
    const afterRemove = await svc.get({ userId: USER_A });
    expect(afterRemove).toHaveLength(1);
    expect(afterRemove[0]?.field).toBe('model');
  });

  it('set is idempotent (upsert on conflict)', async () => {
    const db = makeMemoryDb();
    const svc = createPrefsService({ db });
    await svc.set({
      userId: USER_A,
      toolName: 'docs.put',
      field: 'namespace',
      value: 'work',
    });
    await svc.set({
      userId: USER_A,
      toolName: 'docs.put',
      field: 'namespace',
      value: 'personal',
    });
    const got = await svc.get({ userId: USER_A });
    expect(got).toHaveLength(1);
    expect(got[0]?.value).toBe('personal');
  });

  it('user isolation — USER_A cannot see USER_B prefs', async () => {
    const db = makeMemoryDb();
    const svc = createPrefsService({ db });
    await svc.set({
      userId: USER_A,
      toolName: 'docs.put',
      field: 'tag',
      value: 'a-tag',
    });
    await svc.set({
      userId: USER_B,
      toolName: 'docs.put',
      field: 'tag',
      value: 'b-tag',
    });
    const aGot = await svc.get({ userId: USER_A });
    const bGot = await svc.get({ userId: USER_B });
    expect(aGot).toHaveLength(1);
    expect(aGot[0]?.value).toBe('a-tag');
    expect(bGot).toHaveLength(1);
    expect(bGot[0]?.value).toBe('b-tag');
  });

  it('rejects invalid scope', async () => {
    const db = makeMemoryDb();
    const svc = createPrefsService({ db });
    await expect(
      svc.set({
        userId: USER_A,
        toolName: 'x',
        field: 'y',
        value: 1,
        scope: 'global' as never,
      }),
    ).rejects.toThrow(/invalid scope/);
  });

  it('resolveForTool: user-args WIN over tool-default', async () => {
    const db = makeMemoryDb();
    const svc = createPrefsService({ db });
    await svc.set({
      userId: USER_A,
      toolName: 'llm.ask',
      field: 'model',
      value: 'gemini-3-flash',
    });
    await svc.set({
      userId: USER_A,
      toolName: 'llm.ask',
      field: 'temperature',
      value: 0.5,
    });
    const result = await svc.resolveForTool({
      userId: USER_A,
      toolName: 'llm.ask',
      userInput: { model: 'gemini-3-pro', prompt: 'hi' },
    });
    expect(result.resolvedInput['model']).toBe('gemini-3-pro');
    expect(result.resolvedInput['temperature']).toBe(0.5);
    expect(result.resolvedInput['prompt']).toBe('hi');

    const sources = Object.fromEntries(
      result.defaultsApplied.map((d) => [d.field, d.from]),
    );
    expect(sources['model']).toBe('user-input');
    expect(sources['prompt']).toBe('user-input');
    expect(sources['temperature']).toBe('tool-default');
  });

  it('resolveForTool: tool-default fills undefined user-input', async () => {
    const db = makeMemoryDb();
    const svc = createPrefsService({ db });
    await svc.set({
      userId: USER_A,
      toolName: 'llm.ask',
      field: 'model',
      value: 'gemini-3-pro',
    });
    const result = await svc.resolveForTool({
      userId: USER_A,
      toolName: 'llm.ask',
      userInput: { model: undefined, prompt: 'hi' },
    });
    expect(result.resolvedInput['model']).toBe('gemini-3-pro');
    const applied = result.defaultsApplied.find((d) => d.field === 'model');
    expect(applied?.from).toBe('tool-default');
    expect(applied?.scope).toBe('user');
  });

  it('resolveForTool: scope hierarchy session > user > tenant', async () => {
    const db = makeMemoryDb();
    const svc = createPrefsService({ db });
    // 3x same field, different scopes
    await svc.set({
      userId: USER_A,
      toolName: 'llm.ask',
      field: 'model',
      value: 'tenant-model',
      scope: 'tenant',
    });
    await svc.set({
      userId: USER_A,
      toolName: 'llm.ask',
      field: 'model',
      value: 'user-model',
      scope: 'user',
    });
    await svc.set({
      userId: USER_A,
      toolName: 'llm.ask',
      field: 'model',
      value: 'session-model',
      scope: 'session',
    });

    const result = await svc.resolveForTool({
      userId: USER_A,
      toolName: 'llm.ask',
      userInput: {},
    });
    expect(result.resolvedInput['model']).toBe('session-model');
    const applied = result.defaultsApplied.find((d) => d.field === 'model');
    expect(applied?.scope).toBe('session');
  });

  it('resolveForTool: no defaults → echoes input', async () => {
    const db = makeMemoryDb();
    const svc = createPrefsService({ db });
    const result = await svc.resolveForTool({
      userId: USER_A,
      toolName: 'llm.ask',
      userInput: { prompt: 'hello' },
    });
    expect(result.resolvedInput).toEqual({ prompt: 'hello' });
    expect(result.defaultsApplied.every((d) => d.from === 'user-input')).toBe(true);
  });
});
