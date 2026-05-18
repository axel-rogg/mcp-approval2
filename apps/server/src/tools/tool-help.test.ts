/**
 * Unit-Tests fuer tools.help (Phase D, PLAN-tool-defaults-v2.md).
 *
 * Scope:
 *   - response-Shape stimmt mit Plan §5.D ueberein
 *   - tool=null bei unknown tool
 *   - effective + fields_with_defaults korrekt aus dem aktiven Profil
 *   - orphan-Fields wandern in orphan_fields[], NICHT in effective
 *   - fields_without_defaults aus dem inputSchema minus den belegten
 *   - available_profiles inkl. active-Flag
 *   - hints=Object (Phase E befuellt, Phase D leer)
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolContext } from '../mcp/protocol/tool.js';
import { ToolRegistry } from '../mcp/protocol/registry.js';
import { makeToolHelpTool } from './tool-help.js';
import type {
  ToolDefault,
  UserServerToolDefaultsService,
} from '../services/user-server-tool-defaults.js';
import type {
  ToolDefaultProfile,
  ToolDefaultProfilesService,
} from '../services/tool-default-profiles.js';
import type {
  ToolDefaultsService,
  ToolDefaultsSummary,
} from '../services/tool-defaults.js';

function makeStubs(opts: {
  profiles?: ReadonlyArray<ToolDefaultProfile>;
  defaultsByTool?: Record<string, ReadonlyArray<ToolDefault>>;
}): {
  toolDefaults: ToolDefaultsService;
  userServerToolDefaults: UserServerToolDefaultsService;
  toolDefaultProfiles: ToolDefaultProfilesService;
} {
  const profiles = opts.profiles ?? [];
  const defaultsByTool = opts.defaultsByTool ?? {};

  const toolDefaultProfiles: ToolDefaultProfilesService = {
    async list() {
      return profiles;
    },
    async getActive() {
      return profiles.find((p) => p.isActive) ?? null;
    },
    async activeProfileNameFor() {
      return profiles.find((p) => p.isActive)?.profileName ?? 'default';
    },
    async exists(_u, _s, name) {
      return profiles.some((p) => p.profileName === name);
    },
    async create() {
      throw new Error('not used in tests');
    },
    async activate() {
      throw new Error('not used in tests');
    },
    async delete() {
      throw new Error('not used in tests');
    },
  };

  const userServerToolDefaults: UserServerToolDefaultsService = {
    async listByServer() {
      return Object.values(defaultsByTool).flat();
    },
    async listByTool(_u, _s, toolName, profileName) {
      const arr = defaultsByTool[toolName] ?? [];
      return profileName ? arr.filter((d) => d.profileName === profileName) : arr;
    },
    async set() {
      throw new Error('not used');
    },
    async remove() {
      throw new Error('not used');
    },
    async removeAllForServer() {
      throw new Error('not used');
    },
    async markOrphan() {
      throw new Error('not used');
    },
  };

  const toolDefaults: ToolDefaultsService = {
    async resolveForTool() {
      throw new Error('not used in tools.help');
    },
    async summarizeForUser(): Promise<ReadonlyMap<string, ToolDefaultsSummary>> {
      return new Map();
    },
  };

  return { toolDefaults, userServerToolDefaults, toolDefaultProfiles };
}

function makeCtx(): ToolContext {
  return {
    userId: 'u1',
    email: 'alice@example.com',
    role: 'member',
    requestId: 'req-1',
    audit: { emit: async () => {} } as unknown as ToolContext['audit'],
    db: {} as unknown as ToolContext['db'],
    signal: new AbortController().signal,
  };
}

describe('tools.help', () => {
  it('returns tool=null when name is not registered', async () => {
    const reg = new ToolRegistry();
    const deps = makeStubs({});
    const tool = makeToolHelpTool({ registry: reg, ...deps });
    const out = await tool.execute(makeCtx(), { name: 'ghost.tool' });
    expect(out.tool).toBeNull();
  });

  it('returns shape per Plan §5.D when tool exists', async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: 'gws.calendar.list',
      description: 'List calendar events',
      sensitivity: 'read',
      inputSchema: z.object({
        max_results: z.number().int().min(1).max(100),
        time_zone: z.string(),
        calendar_id: z.string(),
      }),
      async execute() {
        return [];
      },
    });
    const deps = makeStubs({
      profiles: [
        {
          userId: 'u1',
          subMcpName: 'gws',
          profileName: 'prod',
          description: 'Produktion',
          isActive: true,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          userId: 'u1',
          subMcpName: 'gws',
          profileName: 'test',
          description: '',
          isActive: false,
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      defaultsByTool: {
        'gws.calendar.list': [
          {
            userId: 'u1',
            subMcpName: 'gws',
            profileName: 'prod',
            toolName: 'gws.calendar.list',
            fieldName: 'max_results',
            value: 25,
            valueKind: 'number',
            isSecret: false,
            orphanSince: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    });
    const tool = makeToolHelpTool({
      registry: reg,
      ...deps,
      subMcpServerNames: async () => new Set(['gws']),
    });
    const out = await tool.execute(makeCtx(), { name: 'gws.calendar.list' });
    expect(out.tool?.name).toBe('gws.calendar.list');
    expect(out.tool?.sensitivity).toBe('read');
    expect(out.subMcpName).toBe('gws');
    expect(out.defaults.active_profile).toBe('prod');
    expect(out.defaults.effective).toEqual({ max_results: 25 });
    expect(out.defaults.fields_with_defaults).toEqual(['max_results']);
    expect(out.defaults.fields_without_defaults.sort()).toEqual(
      ['calendar_id', 'time_zone'].sort(),
    );
    expect(out.defaults.orphan_fields).toEqual([]);
    expect(out.available_profiles).toEqual([
      { name: 'prod', description: 'Produktion', active: true },
      { name: 'test', description: '', active: false },
    ]);
    expect(out.hints).toEqual({}); // Phase E befuellt
  });

  it('separates orphan fields from effective', async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: 'gws.calendar.list',
      description: 'test fixture',
      sensitivity: 'read',
      inputSchema: z.object({ max_results: z.number() }),
      async execute() {
        return [];
      },
    });
    const deps = makeStubs({
      profiles: [
        {
          userId: 'u1',
          subMcpName: 'gws',
          profileName: 'default',
          description: '',
          isActive: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      defaultsByTool: {
        'gws.calendar.list': [
          {
            userId: 'u1',
            subMcpName: 'gws',
            profileName: 'default',
            toolName: 'gws.calendar.list',
            fieldName: 'gone_field',
            value: 'x',
            valueKind: 'text',
            isSecret: false,
            orphanSince: 1234,
            createdAt: 1,
            updatedAt: 1,
          },
          {
            userId: 'u1',
            subMcpName: 'gws',
            profileName: 'default',
            toolName: 'gws.calendar.list',
            fieldName: 'max_results',
            value: 25,
            valueKind: 'number',
            isSecret: false,
            orphanSince: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    });
    const tool = makeToolHelpTool({ registry: reg, ...deps });
    const out = await tool.execute(makeCtx(), { name: 'gws.calendar.list' });
    expect(out.defaults.effective).toEqual({ max_results: 25 });
    expect(out.defaults.orphan_fields).toEqual(['gone_field']);
    expect(out.defaults.fields_with_defaults).toEqual(['max_results']);
  });

  it('adds implicit default profile when DB has none', async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: 'tools.help',
      description: 'test fixture',
      sensitivity: 'read',
      inputSchema: z.object({ name: z.string() }),
      async execute() {
        return [];
      },
    });
    const deps = makeStubs({});
    const tool = makeToolHelpTool({ registry: reg, ...deps });
    const out = await tool.execute(makeCtx(), { name: 'tools.help' });
    expect(out.defaults.active_profile).toBe('default');
    expect(out.available_profiles).toEqual([
      { name: 'default', description: '', active: true },
    ]);
  });
});
