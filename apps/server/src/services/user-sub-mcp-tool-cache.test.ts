import { describe, expect, it } from 'vitest';
import type { DbAdapter, ScopedDb, RawDb } from '@mcp-approval2/adapters';
import { createUserSubMcpToolCacheService } from './user-sub-mcp-tool-cache.js';

interface CapturedSql {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
}

interface TestDb {
  readonly db: DbAdapter;
  readonly captured: CapturedSql[];
  readonly scopedQueries: CapturedSql[];
}

function makeTestDb(scopedResponses: ReadonlyArray<ReadonlyArray<unknown>>): TestDb {
  const captured: CapturedSql[] = [];
  const scopedQueries: CapturedSql[] = [];
  let scopedIdx = 0;
  let unsafeIdx = 0;

  const scopedDb: ScopedDb = {
    async query<T>(sql: string, params?: ReadonlyArray<unknown>): Promise<T[]> {
      scopedQueries.push({ sql, params: params ?? [] });
      const out = scopedResponses[scopedIdx] ?? [];
      scopedIdx += 1;
      return out as T[];
    },
  } as ScopedDb;

  const unsafeResponses: Array<ReadonlyArray<unknown>> = [];
  const rawDb: RawDb = {
    async query<T>(sql: string, params?: ReadonlyArray<unknown>): Promise<T[]> {
      captured.push({ sql, params: params ?? [] });
      const out = unsafeResponses[unsafeIdx] ?? [];
      unsafeIdx += 1;
      return out as T[];
    },
  };

  const db: DbAdapter = {
    unsafe: () => rawDb,
    scoped: () => {
      throw new Error('scoped not used in this test');
    },
    transaction: async <T>(_userId: string, cb: (s: ScopedDb) => Promise<T>): Promise<T> => {
      return cb(scopedDb);
    },
  } as unknown as DbAdapter;

  return { db, captured, scopedQueries };
}

describe('UserSubMcpToolCacheService', () => {
  it('read() returns null when no row', async () => {
    const { db } = makeTestDb([[]]);
    const svc = createUserSubMcpToolCacheService({ db });
    const result = await svc.read('user-1', 'cf');
    expect(result).toBeNull();
  });

  it('read() parses tools_json + cached_at', async () => {
    const tools = [{ name: 'cf.kv_namespace_list', description: 'List KV ns' }];
    const { db } = makeTestDb([
      [
        {
          user_id: 'user-1',
          sub_mcp_id: 'sub-uuid-1',
          sub_mcp_name: 'cf',
          tools_json: tools,
          cached_at: 1700000000000,
        },
      ],
    ]);
    const svc = createUserSubMcpToolCacheService({ db });
    const result = await svc.read('user-1', 'cf');
    expect(result?.subMcpName).toBe('cf');
    expect(result?.tools).toHaveLength(1);
    expect(result?.tools[0]?.name).toBe('cf.kv_namespace_list');
    expect(result?.cachedAt).toBe(1700000000000);
  });

  it('write() upserts with all required params', async () => {
    const { db, scopedQueries } = makeTestDb([[]]);
    const svc = createUserSubMcpToolCacheService({
      db,
      now: () => 1700000000000,
    });
    await svc.write({
      userId: 'user-1',
      subMcpId: 'sub-uuid-1',
      subMcpName: 'cf',
      tools: [{ name: 'cf.foo' }],
    });
    expect(scopedQueries).toHaveLength(1);
    const q = scopedQueries[0];
    expect(q?.sql).toContain('INSERT INTO user_sub_mcp_tool_cache');
    expect(q?.sql).toContain('ON CONFLICT (user_id, sub_mcp_id) DO UPDATE');
    expect(q?.params[0]).toBe('user-1');
    expect(q?.params[1]).toBe('sub-uuid-1');
    expect(q?.params[2]).toBe('cf');
    expect(q?.params[4]).toBe(1700000000000);
    const toolsParam = JSON.parse(String(q?.params[3])) as Array<{ name: string }>;
    expect(toolsParam[0]?.name).toBe('cf.foo');
  });

  it('listForUser() returns all rows for that user', async () => {
    const { db } = makeTestDb([
      [
        {
          user_id: 'user-1',
          sub_mcp_id: 'sub-uuid-1',
          sub_mcp_name: 'cf',
          tools_json: [],
          cached_at: 1,
        },
        {
          user_id: 'user-1',
          sub_mcp_id: 'sub-uuid-2',
          sub_mcp_name: 'github',
          tools_json: [],
          cached_at: 2,
        },
      ],
    ]);
    const svc = createUserSubMcpToolCacheService({ db });
    const result = await svc.listForUser('user-1');
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.subMcpName).sort()).toEqual(['cf', 'github']);
  });

  it('remove() deletes by user_id + sub_mcp_name', async () => {
    const { db, scopedQueries } = makeTestDb([[]]);
    const svc = createUserSubMcpToolCacheService({ db });
    await svc.remove('user-1', 'cf');
    expect(scopedQueries[0]?.sql).toContain('DELETE FROM user_sub_mcp_tool_cache');
    expect(scopedQueries[0]?.params).toEqual(['user-1', 'cf']);
  });

  it('cleanupStale() uses raw unsafe + returns count', async () => {
    // cleanupStale geht ueber unsafe(); wir muessen ein anderes Mock-Setup nehmen
    const captured: Array<{ sql: string; params: ReadonlyArray<unknown> }> = [];
    const rawDb: RawDb = {
      async query<T>(sql: string, params?: ReadonlyArray<unknown>): Promise<T[]> {
        captured.push({ sql, params: params ?? [] });
        return [{ count: 5 }] as T[];
      },
    };
    const db: DbAdapter = {
      unsafe: () => rawDb,
      scoped: () => {
        throw new Error('not used');
      },
      transaction: () => {
        throw new Error('not used');
      },
    } as unknown as DbAdapter;
    const svc = createUserSubMcpToolCacheService({ db });
    const count = await svc.cleanupStale(1700000000000);
    expect(count).toBe(5);
    expect(captured[0]?.sql).toContain('DELETE FROM user_sub_mcp_tool_cache');
    expect(captured[0]?.params[0]).toBe(1700000000000);
  });
});
