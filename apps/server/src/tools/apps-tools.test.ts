/**
 * Apps-Tools smoke tests.
 *
 * Coverage:
 *   - all 8 tools registered with correct names + sensitivities
 *   - input schema validation greift bei invalidem Input
 *   - read tools dispatchen direkt; write tools auch (Approval-Gate ist
 *     ToolRegistry-Concern, hier nur Tool-Funktion)
 *   - block-catalog hat 13 registered Blocks
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { listBlocks, _resetForTesting, bootBlockCatalog } from '../apps/blocks/index.js';
import { createAppsService, type AppsService } from '../apps/api.js';
import {
  makeAppsCreateTool,
  makeAppsDeleteTool,
  makeAppsInvokeTool,
  makeAppsListTool,
  makeAppsQueryTool,
  makeAppsReadTool,
  makeAppsTools,
  makeAppsUpdateLayoutTool,
  makeAppsUpdateStateTool,
} from './apps-tools.js';

const USER_ID = '00000000-0000-0000-0000-00000000aaaa';

function makeServiceStub(): AppsService {
  // We don't need a fully-wired KnowledgeService for these schema/dispatch
  // smoke tests. We expose a thin in-memory stub matching the AppsService
  // surface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state: any = {};
  let counter = 0;
  return {
    async createApp(args) {
      counter += 1;
      const id = `app-${counter}`;
      const inst = {
        id,
        userId: args.userId,
        type: args.appType,
        title: args.title ?? 'Composable App',
        state_version: 1,
        schema_version: 1,
        pinned: false,
        archived: false,
        created_at: 1,
        updated_at: 1,
        last_used_at: null,
      };
      state[id] = { inst, layout: args.initialState ?? { version: 'v0.10', components: [], state: {} } };
      return inst;
    },
    async readApp(args) {
      const e = state[args.id];
      if (!e) throw new Error(`404 not found: ${args.id}`);
      return { app: e.inst, state: e.layout };
    },
    async updateState(args) {
      const e = state[args.id];
      if (!e) throw new Error(`404 not found: ${args.id}`);
      if (args.expectedVersion !== e.inst.state_version) {
        throw new Error(`409 cas_conflict`);
      }
      e.inst = { ...e.inst, state_version: e.inst.state_version + 1 };
      e.layout = args.statePatch;
      return e.inst;
    },
    async listApps(args) {
      return Object.values(state)
        .map((v) => (v as { inst: typeof state['x']['inst'] }).inst)
        .filter((i) => i.userId === args.userId);
    },
    async deleteApp(args) {
      delete state[args.id];
    },
    async invoke(args) {
      const e = state[args.id];
      e.inst = { ...e.inst, state_version: e.inst.state_version + 1 };
      return { app: e.inst, new_version: e.inst.state_version, result: { ok: true }, patches: [] };
    },
    async query(_args) {
      return 'stubbed';
    },
    async updateLayout(args) {
      const e = state[args.id];
      e.inst = { ...e.inst, state_version: e.inst.state_version + 1 };
      e.layout = args.layoutDoc;
      return e.inst;
    },
  };
}

function makeCtx() {
  return {
    userId: USER_ID,
    email: 'test@example.com',
    role: 'member' as const,
    requestId: 'req-1',
    audit: { emit: async () => {} },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: {} as any,
    signal: new AbortController().signal,
  };
}

describe('Apps Tools — registration', () => {
  it('makeAppsTools returns exactly 8 tools', () => {
    const apps = makeServiceStub();
    const tools = makeAppsTools({ apps });
    expect(tools).toHaveLength(8);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'apps.create',
        'apps.delete',
        'apps.invoke',
        'apps.list',
        'apps.query',
        'apps.read',
        'apps.update_layout',
        'apps.update_state',
      ].sort(),
    );
  });

  it('sensitivities are correct', () => {
    const apps = makeServiceStub();
    expect(makeAppsCreateTool({ apps }).sensitivity).toBe('write');
    expect(makeAppsReadTool({ apps }).sensitivity).toBe('read');
    expect(makeAppsListTool({ apps }).sensitivity).toBe('read');
    expect(makeAppsDeleteTool({ apps }).sensitivity).toBe('danger');
    expect(makeAppsUpdateStateTool({ apps }).sensitivity).toBe('write');
    expect(makeAppsInvokeTool({ apps }).sensitivity).toBe('write');
    expect(makeAppsQueryTool({ apps }).sensitivity).toBe('read');
    expect(makeAppsUpdateLayoutTool({ apps }).sensitivity).toBe('write');
  });
});

describe('Apps Tools — dispatch', () => {
  it('create + read + delete roundtrip', async () => {
    const apps = makeServiceStub();
    const ctx = makeCtx();
    const create = makeAppsCreateTool({ apps });
    const read = makeAppsReadTool({ apps });
    const del = makeAppsDeleteTool({ apps });
    const inst = await create.execute(ctx, { app_type: 'composable', title: 'X' });
    expect(inst.title).toBe('X');
    const r = await read.execute(ctx, { id: inst.id });
    expect(r.app.id).toBe(inst.id);
    const d = await del.execute(ctx, { id: inst.id });
    expect(d.deleted).toBe(true);
  });

  it('update_state passes expected_version to service', async () => {
    const apps = makeServiceStub();
    const ctx = makeCtx();
    const create = makeAppsCreateTool({ apps });
    const update = makeAppsUpdateStateTool({ apps });
    const inst = await create.execute(ctx, { app_type: 'composable' });
    const updated = await update.execute(ctx, {
      id: inst.id,
      expected_version: 1,
      new_state: { version: 'v0.10', components: [], state: {} },
    });
    expect(updated.new_version).toBe(2);
  });

  it('list filters by userId via ctx', async () => {
    const apps = makeServiceStub();
    const ctx = makeCtx();
    const create = makeAppsCreateTool({ apps });
    const list = makeAppsListTool({ apps });
    await create.execute(ctx, { app_type: 'composable', title: 'A1' });
    await create.execute(ctx, { app_type: 'composable', title: 'A2' });
    const r = await list.execute(ctx, {});
    expect(r.count).toBe(2);
  });

  it('query passes args to service', async () => {
    const apps = makeServiceStub();
    const ctx = makeCtx();
    const create = makeAppsCreateTool({ apps });
    const query = makeAppsQueryTool({ apps });
    const inst = await create.execute(ctx, { app_type: 'composable' });
    const v = await query.execute(ctx, {
      id: inst.id,
      block_id: 'b1',
      query: 'something',
    });
    expect(v.value).toBe('stubbed');
  });
});

describe('Apps Tools — schema validation', () => {
  it('rejects empty app_type', () => {
    const apps = makeServiceStub();
    const t = makeAppsCreateTool({ apps });
    expect(() => t.inputSchema.parse({ app_type: '' })).toThrow();
  });

  it('rejects negative expected_version', () => {
    const apps = makeServiceStub();
    const t = makeAppsUpdateStateTool({ apps });
    expect(() => t.inputSchema.parse({ id: 'a', expected_version: -1, new_state: {} })).toThrow();
  });

  it('rejects extra fields (strict mode)', () => {
    const apps = makeServiceStub();
    const t = makeAppsCreateTool({ apps });
    expect(() => t.inputSchema.parse({ app_type: 'composable', extra: 'no' })).toThrow();
  });
});

describe('Block Catalog — registration', () => {
  beforeEach(() => {
    _resetForTesting();
    bootBlockCatalog();
  });

  it('registers 15 blocks', () => {
    const blocks = listBlocks();
    expect(blocks.length).toBe(15);
  });

  it('contains the documented set', () => {
    const types = listBlocks().map((b) => b.type).sort();
    expect(types).toEqual(
      [
        'action_button',
        'calendar_grid',
        'chart',
        'counter',
        'form',
        'header',
        'list',
        'places',
        'progress_ring',
        'reminder',
        'stat_card',
        'tag_filter',
        'text_field',
        'timer',
        'workout_split',
      ].sort(),
    );
  });

  it('all blocks have non-empty a2ui_component + state_schema', () => {
    for (const b of listBlocks()) {
      expect(b.a2ui_component).toMatch(/^[A-Za-z]/);
      expect(b.state_schema).toBeTypeOf('object');
      expect(typeof b.initial_state).toBe('function');
    }
  });
});

describe('Block invokes (form / counter / action_button)', () => {
  it('counter.increment produces /value patch', () => {
    const blocks = listBlocks();
    const counter = blocks.find((b) => b.type === 'counter')!;
    const initial = counter.initial_state() as { value: number };
    const out = counter.actions['increment']!.handler(initial, { by: 5 });
    expect(out.patches).toEqual([{ path: '/value', value: 5 }]);
  });

  it('form.setField produces a value-path patch', () => {
    const blocks = listBlocks();
    const form = blocks.find((b) => b.type === 'form')!;
    const initial = form.initial_state() as { value: Record<string, unknown> };
    const out = form.actions['setField']!.handler(initial, { field: 'name', value: 'Ada' });
    expect(out.patches).toEqual([{ path: '/value/name', value: 'Ada' }]);
  });

  it('action_button.trigger validates payload and emits result', () => {
    const blocks = listBlocks();
    const ab = blocks.find((b) => b.type === 'action_button')!;
    const state = { label: 'Send', kind: 'prompt' as const, payload: { text: 'Hi' } };
    const out = ab.actions['trigger']!.handler(state, {});
    expect(out.result).toMatchObject({ kind: 'prompt', payload: { text: 'Hi' } });
    expect(out.patches).toEqual([]);
  });

  it('action_button.trigger throws on invalid payload for kind=url', () => {
    const blocks = listBlocks();
    const ab = blocks.find((b) => b.type === 'action_button')!;
    const state = { label: 'Go', kind: 'url' as const, payload: { href: 'http://nope' } };
    expect(() => ab.actions['trigger']!.handler(state, {})).toThrow(/https/);
  });
});

describe('createAppsService factory', () => {
  it('is callable with a fake KnowledgeService stub', async () => {
    const fakeKnowledge = {
      createObject: async () => ({ id: 'x', ownerId: USER_ID }),
    };
    // We mainly verify the factory doesn't throw at construction.
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createAppsService({ knowledge: fakeKnowledge as any }),
    ).not.toThrow();
  });
});
