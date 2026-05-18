/**
 * Unit-Tests fuer ToolDefaultsService.resolveForTool (Plan-Ref:
 * PLAN-tool-defaults-v2.md Phase A).
 *
 * Scope:
 *   - subMcpFromToolName: Heuristik native/sub-mcp/kc
 *   - resolveForTool: Args-WIN gegen gespeicherte Defaults
 *   - resolveForTool: leere Defaults → Args 1:1 + Attribution
 *   - resolveForTool: native Tool (kein '.') → subMcpName='native'
 */
import { describe, expect, it } from 'vitest';
import type {
  DbAdapter,
  RawDb,
  ScopedDb,
  TransactionCtx,
} from '@mcp-approval2/adapters';
import { z } from 'zod';
import { ToolRegistry } from '../mcp/protocol/registry.js';
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';
import {
  RESERVED_SUB_MCP_NAMES,
  createToolDefaultsService,
  subMcpFromToolName,
} from './tool-defaults.js';

interface Row {
  user_id: string;
  sub_mcp_name: string;
  tool_name: string;
  field_name: string;
  value_text: string;
}

function makeMemoryDb(seed: ReadonlyArray<Row> = []): DbAdapter {
  const rows: Row[] = seed.map((r) => ({ ...r }));

  function exec<T = unknown>(
    text: string,
    params: ReadonlyArray<unknown> = [],
  ): T[] {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t.startsWith('SELECT tool_name, field_name, profile_name')) {
      const [uid, sub, tool] = params as readonly unknown[];
      return rows
        .filter(
          (r) =>
            r.user_id === uid &&
            r.sub_mcp_name === sub &&
            r.tool_name === tool,
        )
        .map((r) => ({
          tool_name: r.tool_name,
          field_name: r.field_name,
          profile_name: 'default',
          value_text: r.value_text,
          value_json: null,
          value_kind: 'text',
          orphan_since: null,
        })) as unknown as T[];
    }
    // UPDATE orphan_since (lazy-write) — no-op im Mock
    if (t.startsWith('UPDATE user_server_tool_defaults')) {
      return [] as unknown as T[];
    }
    return [] as unknown as T[];
  }

  const scoped: ScopedDb = {
    async query<T>(sql: string, params?: ReadonlyArray<unknown>): Promise<T[]> {
      return exec<T>(sql, params ?? []);
    },
  } as unknown as ScopedDb;

  const adapter: DbAdapter = {
    async scoped<T>(_userId: string, fn: (s: ScopedDb) => Promise<T>): Promise<T> {
      return fn(scoped);
    },
    async transaction<T>(
      _userId: string,
      fn: (s: ScopedDb, tx: TransactionCtx) => Promise<T>,
    ): Promise<T> {
      const tx: TransactionCtx = {
        rollback: async () => {},
      } as unknown as TransactionCtx;
      return fn(scoped, tx);
    },
    async raw<T>(_fn: (db: RawDb) => Promise<T>): Promise<T> {
      throw new Error('raw not implemented in mock');
    },
    async close(): Promise<void> {},
  } as unknown as DbAdapter;
  return adapter;
}

describe('subMcpFromToolName', () => {
  it('returns "native" for bare names', () => {
    expect(subMcpFromToolName('tools.help')).toBe('native');
    expect(subMcpFromToolName('apps.invoke', new Set())).toBe('native');
    expect(subMcpFromToolName('whoami')).toBe('native');
  });

  it('returns the prefix when registered as sub-mcp', () => {
    const subs = new Set(['gws', 'cf', 'github']);
    expect(subMcpFromToolName('gws.calendar.list', subs)).toBe('gws');
    expect(subMcpFromToolName('cf.kv_namespace_list', subs)).toBe('cf');
  });

  it('routes kc.* to knowledge2', () => {
    expect(subMcpFromToolName('kc.docs.put')).toBe('knowledge2');
    expect(subMcpFromToolName('kc.skills.search', new Set())).toBe('knowledge2');
  });

  it('falls back to native if prefix unknown', () => {
    expect(subMcpFromToolName('mystery.tool', new Set(['gws']))).toBe('native');
  });
});

describe('RESERVED_SUB_MCP_NAMES', () => {
  it('contains all native namespaces used today', () => {
    for (const name of ['apps', 'docs', 'skills', 'kc', 'tools', 'prefs', 'native']) {
      expect(RESERVED_SUB_MCP_NAMES.has(name)).toBe(true);
    }
  });
});

describe('ToolRegistry.register: __profile reservation', () => {
  function makeTool(schema: z.ZodTypeAny): Tool<unknown, unknown> {
    return {
      name: 'fake.tool',
      description: 'test',
      sensitivity: 'read',
      inputSchema: schema,
      async execute(_ctx: ToolContext, _input: unknown): Promise<unknown> {
        return {};
      },
    };
  }

  it('rejects tools that declare __profile as a property', () => {
    const reg = new ToolRegistry();
    const tool = makeTool(z.object({ __profile: z.string(), sql: z.string() }));
    expect(() => reg.register(tool)).toThrow(/reserved property '__profile'/);
  });

  it('accepts tools with non-reserved schema', () => {
    const reg = new ToolRegistry();
    const tool = makeTool(z.object({ sql: z.string() }));
    expect(() => reg.register(tool)).not.toThrow();
  });

  it('accepts tools with z.unknown() schema (dynamic kc_wrappers)', () => {
    const reg = new ToolRegistry();
    const tool = makeTool(z.unknown());
    expect(() => reg.register(tool)).not.toThrow();
  });
});

describe('ToolDefaultsService.resolveForTool', () => {
  it('passes args through unchanged when no defaults are stored', async () => {
    const svc = createToolDefaultsService({ db: makeMemoryDb() });
    const out = await svc.resolveForTool({
      userId: 'u1',
      toolName: 'gws.calendar.list',
      args: { calendarId: 'work' },
      subMcpServerNames: new Set(['gws']),
    });
    expect(out.subMcpName).toBe('gws');
    expect(out.resolvedInput).toEqual({ calendarId: 'work' });
    expect(out.defaultsApplied).toEqual([
      { field: 'calendarId', from: 'user-input' },
    ]);
  });

  it('fills in missing fields from defaults', async () => {
    const db = makeMemoryDb([
      {
        user_id: 'u1',
        sub_mcp_name: 'gws',
        tool_name: 'gws.calendar.list',
        field_name: 'max_results',
        value_text: '25',
      },
      {
        user_id: 'u1',
        sub_mcp_name: 'gws',
        tool_name: 'gws.calendar.list',
        field_name: 'time_zone',
        value_text: 'Europe/Zurich',
      },
    ]);
    const svc = createToolDefaultsService({ db });
    const out = await svc.resolveForTool({
      userId: 'u1',
      toolName: 'gws.calendar.list',
      args: { calendarId: 'work' },
      subMcpServerNames: new Set(['gws']),
    });
    expect(out.resolvedInput).toEqual({
      calendarId: 'work',
      max_results: '25',
      time_zone: 'Europe/Zurich',
    });
    expect(out.defaultsApplied).toEqual(
      expect.arrayContaining([
        { field: 'calendarId', from: 'user-input' },
        { field: 'max_results', from: 'tool-default', profile: 'default' },
        { field: 'time_zone', from: 'tool-default', profile: 'default' },
      ]),
    );
  });

  it('does NOT override explicit args (Args-WIN)', async () => {
    const db = makeMemoryDb([
      {
        user_id: 'u1',
        sub_mcp_name: 'gws',
        tool_name: 'gws.calendar.list',
        field_name: 'max_results',
        value_text: '25',
      },
    ]);
    const svc = createToolDefaultsService({ db });
    const out = await svc.resolveForTool({
      userId: 'u1',
      toolName: 'gws.calendar.list',
      args: { max_results: '100' },
      subMcpServerNames: new Set(['gws']),
    });
    expect(out.resolvedInput).toEqual({ max_results: '100' });
    expect(out.defaultsApplied).toEqual([
      { field: 'max_results', from: 'user-input' },
    ]);
  });

  it('treats null/undefined user-values as gaps to fill', async () => {
    const db = makeMemoryDb([
      {
        user_id: 'u1',
        sub_mcp_name: 'native',
        tool_name: 'docs.put',
        field_name: 'category',
        value_text: 'note',
      },
    ]);
    const svc = createToolDefaultsService({ db });
    const out = await svc.resolveForTool({
      userId: 'u1',
      toolName: 'docs.put',
      args: { category: null, body: 'x' },
    });
    expect(out.subMcpName).toBe('native');
    expect(out.resolvedInput['category']).toBe('note');
  });

  it('isolates users (only loads own rows)', async () => {
    const db = makeMemoryDb([
      {
        user_id: 'alice',
        sub_mcp_name: 'gws',
        tool_name: 'gws.calendar.list',
        field_name: 'max_results',
        value_text: '25',
      },
    ]);
    const svc = createToolDefaultsService({ db });
    const bob = await svc.resolveForTool({
      userId: 'bob',
      toolName: 'gws.calendar.list',
      args: {},
      subMcpServerNames: new Set(['gws']),
    });
    expect(bob.resolvedInput).toEqual({});
    expect(bob.defaultsApplied).toEqual([]);
  });

  it('skips orphan defaults (schema-callback says field unknown)', async () => {
    const db = makeMemoryDb([
      {
        user_id: 'u1',
        sub_mcp_name: 'gws',
        tool_name: 'gws.calendar.list',
        field_name: 'gone_field',  // not in schema anymore
        value_text: 'wert',
      },
      {
        user_id: 'u1',
        sub_mcp_name: 'gws',
        tool_name: 'gws.calendar.list',
        field_name: 'max_results',
        value_text: '25',
      },
    ]);
    // Schema kennt nur max_results, nicht gone_field.
    const svc = createToolDefaultsService({
      db,
      schemaFields: () => new Set(['max_results']),
    });
    const out = await svc.resolveForTool({
      userId: 'u1',
      toolName: 'gws.calendar.list',
      args: {},
      subMcpServerNames: new Set(['gws']),
    });
    // gone_field wird NICHT gemerged, max_results schon.
    expect(out.resolvedInput).toEqual({ max_results: '25' });
    expect(out.defaultsApplied.find((d) => d.field === 'gone_field')).toBeUndefined();
  });

  it('does NOT skip when schema-callback returns null (dynamic kc_wrappers)', async () => {
    const db = makeMemoryDb([
      {
        user_id: 'u1',
        sub_mcp_name: 'knowledge2',
        tool_name: 'kc.docs.put',
        field_name: 'category',
        value_text: 'note',
      },
    ]);
    const svc = createToolDefaultsService({
      db,
      schemaFields: () => null, // simulate kc.* z.unknown()
    });
    const out = await svc.resolveForTool({
      userId: 'u1',
      toolName: 'kc.docs.put',
      args: {},
    });
    expect(out.resolvedInput['category']).toBe('note');
  });

  it('Phase C: __profile-Override gets stripped from args + appears in attribution', async () => {
    const db = makeMemoryDb([]);
    const svc = createToolDefaultsService({ db });
    const out = await svc.resolveForTool({
      userId: 'u1',
      toolName: 'gws.calendar.list',
      args: { __profile: 'test', sql: 'SELECT 1' },
      subMcpServerNames: new Set(['gws']),
    });
    expect(out.resolvedInput).toEqual({ sql: 'SELECT 1' }); // __profile gestripped
    expect(out.profileName).toBe('test');
    expect(out.defaultsApplied.find((d) => d.field === '__profile')?.profile).toBe('test');
  });

  it('Phase C: ignores __profile with invalid slug pattern', async () => {
    const db = makeMemoryDb([]);
    const svc = createToolDefaultsService({ db });
    const out = await svc.resolveForTool({
      userId: 'u1',
      toolName: 'gws.calendar.list',
      args: { __profile: 'INVALID Name', sql: 'x' },
      subMcpServerNames: new Set(['gws']),
    });
    // ignored: profile bleibt default; __profile aber trotzdem gestripped
    // (Resolver vertraut User nicht den Worker mit dem dirty value zu fluten).
    expect(out.resolvedInput).toEqual({ sql: 'x' });
    expect(out.profileName).toBe('default');
  });

  it('Phase C: attribution carries profile-name for tool-default fields', async () => {
    const db = makeMemoryDb([
      {
        user_id: 'u1',
        sub_mcp_name: 'gws',
        tool_name: 'gws.calendar.list',
        field_name: 'max_results',
        value_text: '25',
      },
    ]);
    const svc = createToolDefaultsService({ db });
    const out = await svc.resolveForTool({
      userId: 'u1',
      toolName: 'gws.calendar.list',
      args: {},
      subMcpServerNames: new Set(['gws']),
    });
    const def = out.defaultsApplied.find((d) => d.field === 'max_results');
    expect(def?.profile).toBe('default');
  });
});
