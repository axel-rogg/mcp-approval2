/**
 * Unit-Tests fuer ToolDefaultHintsService (Phase E).
 *
 * Plan-Ref: PLAN-tool-defaults-v2.md (Phase E).
 *
 * Scope:
 *   - set / list / listByTool / hasAnyForTool / remove
 *   - Length-Cap (≤500 chars)
 *   - Per-User-Isolation
 *   - Profile-uebergreifend (PK ohne profile_name)
 */
import { describe, expect, it } from 'vitest';
import type {
  DbAdapter,
  RawDb,
  ScopedDb,
  TransactionCtx,
} from '@mcp-approval2/adapters';
import { HttpError } from '../lib/errors.js';
import { createToolDefaultHintsService } from './tool-default-hints.js';

interface HintRow {
  user_id: string;
  sub_mcp_name: string;
  tool_name: string;
  field_name: string;
  hint_text: string;
  created_at: number;
  updated_at: number;
}

function makeMemoryDb(seed: ReadonlyArray<HintRow> = []): DbAdapter {
  const rows: HintRow[] = seed.map((r) => ({ ...r }));

  function key(r: Pick<HintRow, 'user_id' | 'sub_mcp_name' | 'tool_name' | 'field_name'>): string {
    return `${r.user_id}|${r.sub_mcp_name}|${r.tool_name}|${r.field_name}`;
  }

  function exec<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): T[] {
    const t = sql.replace(/\s+/g, ' ').trim();

    if (t.startsWith('SELECT user_id, sub_mcp_name, tool_name, field_name')) {
      const [uid, sub] = params as readonly unknown[];
      const tool = params[2] as string | undefined;
      return rows
        .filter(
          (r) =>
            r.user_id === uid &&
            r.sub_mcp_name === sub &&
            (tool === undefined || r.tool_name === tool),
        )
        .map((r) => ({ ...r })) as unknown as T[];
    }

    if (t.startsWith('SELECT 1 AS exists FROM user_tool_default_hints')) {
      const [uid, sub, tool] = params as readonly unknown[];
      const found = rows.some(
        (r) => r.user_id === uid && r.sub_mcp_name === sub && r.tool_name === tool,
      );
      return (found ? [{ exists: true }] : []) as unknown as T[];
    }

    if (t.startsWith('INSERT INTO user_tool_default_hints')) {
      const [uid, sub, tool, field, text, ts] = params as readonly unknown[];
      const newRow: HintRow = {
        user_id: String(uid),
        sub_mcp_name: String(sub),
        tool_name: String(tool),
        field_name: String(field),
        hint_text: String(text),
        created_at: Number(ts),
        updated_at: Number(ts),
      };
      const idx = rows.findIndex((r) => key(r) === key(newRow));
      if (idx >= 0) rows[idx] = newRow;
      else rows.push(newRow);
      return [newRow] as unknown as T[];
    }

    if (t.startsWith('DELETE FROM user_tool_default_hints')) {
      const [uid, sub, tool, field] = params as readonly unknown[];
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (!r) continue;
        if (
          r.user_id === uid &&
          r.sub_mcp_name === sub &&
          r.tool_name === tool &&
          r.field_name === field
        ) {
          rows.splice(i, 1);
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

describe('ToolDefaultHintsService', () => {
  it('set + listByTool roundtrip', async () => {
    const svc = createToolDefaultHintsService({ db: makeMemoryDb() });
    await svc.set({
      userId: 'u1',
      subMcpName: 'gws',
      toolName: 'gws.calendar.list',
      fieldName: 'max_results',
      hintText: '1..100, höher = teurer aber weniger Pagination',
    });
    const list = await svc.listByTool('u1', 'gws', 'gws.calendar.list');
    expect(list).toHaveLength(1);
    expect(list[0]?.hintText).toMatch(/Pagination/);
  });

  it('hasAnyForTool returns true after set', async () => {
    const svc = createToolDefaultHintsService({ db: makeMemoryDb() });
    expect(await svc.hasAnyForTool('u1', 'gws', 'gws.calendar.list')).toBe(false);
    await svc.set({
      userId: 'u1',
      subMcpName: 'gws',
      toolName: 'gws.calendar.list',
      fieldName: 'max_results',
      hintText: 'x',
    });
    expect(await svc.hasAnyForTool('u1', 'gws', 'gws.calendar.list')).toBe(true);
  });

  it('rejects hint > 500 chars', async () => {
    const svc = createToolDefaultHintsService({ db: makeMemoryDb() });
    await expect(
      svc.set({
        userId: 'u1',
        subMcpName: 'gws',
        toolName: 'gws.calendar.list',
        fieldName: 'max_results',
        hintText: 'x'.repeat(501),
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it('remove drops the row', async () => {
    const svc = createToolDefaultHintsService({ db: makeMemoryDb() });
    await svc.set({
      userId: 'u1',
      subMcpName: 'gws',
      toolName: 'gws.calendar.list',
      fieldName: 'max_results',
      hintText: 'x',
    });
    await svc.remove('u1', 'gws', 'gws.calendar.list', 'max_results');
    const list = await svc.listByTool('u1', 'gws', 'gws.calendar.list');
    expect(list).toEqual([]);
  });

  it('isolates users (Alice hints invisible to Bob)', async () => {
    const svc = createToolDefaultHintsService({ db: makeMemoryDb() });
    await svc.set({
      userId: 'alice',
      subMcpName: 'gws',
      toolName: 'gws.calendar.list',
      fieldName: 'max_results',
      hintText: 'private',
    });
    const bobList = await svc.listByTool('bob', 'gws', 'gws.calendar.list');
    expect(bobList).toEqual([]);
    expect(await svc.hasAnyForTool('bob', 'gws', 'gws.calendar.list')).toBe(false);
  });
});
