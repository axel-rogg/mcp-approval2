/**
 * Unit-Tests: applyGatewayDiscovery + SubMcpWrappersCache.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.4.
 */
import { describe, it, expect } from 'vitest';
import { applyGatewayDiscovery, SubMcpWrappersCache } from './refresh.js';
import { SubMcpForwarder } from './forwarder.js';
import { ToolRegistry } from '../protocol/registry.js';
import type {
  SubMcpRegistry,
  RegisterSubMcpArgs,
} from './registry.js';
import type {
  SubMcpServerConfig,
  SubMcpToolCacheEntry,
} from './types.js';
import { SubMcpNotFoundError } from './types.js';

const TEST_CONFIG = { JWT_SECRET: 'a'.repeat(32), JWT_ISSUER: 'mcp-approval2' };

function makeCfg(
  name: string,
  toolsCache: ReadonlyArray<SubMcpToolCacheEntry> | null,
  baseUrl = `https://${name}.test`,
): SubMcpServerConfig {
  return {
    id: `id-${name}`,
    name,
    displayName: name.toUpperCase(),
    baseUrl,
    authMode: 'service_bearer',
    authConfig: { service_token_hash: 'hash' },
    enabled: true,
    serviceToken: 'plain-token',
    toolsCache,
    toolsCachedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

/**
 * Mutable in-memory SubMcpRegistry-Stub. Hat genug Verhalten fuer den
 * Test-Pfad: getByName, listEnabled, updateToolsCache, invalidate. Andere
 * Methoden throwen.
 */
function makeStubRegistry(initial: SubMcpServerConfig[]): SubMcpRegistry {
  const map = new Map<string, SubMcpServerConfig>(initial.map((c) => [c.name, c]));
  return {
    async getByName(n) {
      const cfg = map.get(n);
      if (!cfg) throw new SubMcpNotFoundError(n);
      return cfg;
    },
    async listEnabled() {
      return [...map.values()].filter((c) => c.enabled);
    },
    async listAll() {
      return [...map.values()];
    },
    async updateToolsCache(id, tools) {
      for (const [name, cfg] of map) {
        if (cfg.id === id) {
          map.set(name, { ...cfg, toolsCache: [...tools] });
          break;
        }
      }
    },
    async verifyServiceToken() {
      return null;
    },
    async register(_args: RegisterSubMcpArgs) {
      throw new Error('not supported in stub');
    },
    invalidate() {},
  };
}

describe('SubMcpWrappersCache', () => {
  it('tracks per-server tool-name sets + total count', () => {
    const c = new SubMcpWrappersCache();
    c.setForServer('utils', ['utils.now', 'utils.cal.week']);
    c.setForServer('gws', ['gws.calendar.list']);
    expect(c.totalCount()).toBe(3);
    expect([...c.getForServer('utils')]).toEqual(['utils.now', 'utils.cal.week']);
    expect(c.serverNames().sort()).toEqual(['gws', 'utils']);
    c.delete('utils');
    expect(c.totalCount()).toBe(1);
    expect(c.getForServer('utils').size).toBe(0);
  });
});

describe('applyGatewayDiscovery', () => {
  it('de-registers old wrapper-tools + registers new ones from refreshed cache', async () => {
    const oldTools: SubMcpToolCacheEntry[] = [{ name: 'oldtool', description: 'gone' }];
    const newTools: SubMcpToolCacheEntry[] = [
      { name: 'now', description: 'fresh', annotations: { sensitivity: 'read' as const } },
      { name: 'cal.week', description: 'fresh-2', annotations: { readOnlyHint: true } },
    ];
    const cfg = makeCfg('utils', oldTools);
    const registry = makeStubRegistry([cfg]);
    const toolRegistry = new ToolRegistry();
    // Vortaeuschen: alte Wrapper sind schon registriert (Boot-Sequenz).
    toolRegistry.register({
      name: 'utils.oldtool',
      description: 'gone',
      sensitivity: 'write',
      inputSchema: { parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: true, data: v }) } as never,
      execute: async () => ({}),
    });
    const cache = new SubMcpWrappersCache();
    cache.setForServer('utils', ['utils.oldtool']);

    // Fake-fetch das `tools/list` mit neuen Tools antwortet.
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          result: { tools: newTools },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    const forwarder = new SubMcpForwarder({ registry, fetchImpl: fakeFetch });
    const result = await applyGatewayDiscovery({
      registry,
      toolRegistry,
      forwarder,
      config: TEST_CONFIG,
      cache,
      fetchImpl: fakeFetch,
    });

    expect(result.deregistered).toBe(1);
    expect(result.registered).toBe(2);
    expect(result.failed).toEqual([]);
    expect(result.perSubMcp.get('utils')).toBe(2);
    // Old tool weg
    expect(toolRegistry.has('utils.oldtool')).toBe(false);
    // New tools da
    expect(toolRegistry.has('utils.now')).toBe(true);
    expect(toolRegistry.has('utils.cal.week')).toBe(true);
    // Cache auf neuem Stand
    expect([...cache.getForServer('utils')].sort()).toEqual(['utils.cal.week', 'utils.now']);
  });

  it('skips servers whose tools/list-call fails — leaves old wrappers untouched', async () => {
    const cfg = makeCfg('gws', [{ name: 'calendar.list', description: 'old' }]);
    const registry = makeStubRegistry([cfg]);
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'gws.calendar.list',
      description: 'old',
      sensitivity: 'write',
      inputSchema: { parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: true, data: v }) } as never,
      execute: async () => ({}),
    });
    const cache = new SubMcpWrappersCache();
    cache.setForServer('gws', ['gws.calendar.list']);

    // Simulate Network-Fail.
    const failingFetch: typeof fetch = async () =>
      new Response('upstream broken', { status: 502 });
    const forwarder = new SubMcpForwarder({ registry, fetchImpl: failingFetch });
    const result = await applyGatewayDiscovery({
      registry,
      toolRegistry,
      forwarder,
      config: TEST_CONFIG,
      cache,
      fetchImpl: failingFetch,
    });

    expect(result.failed).toEqual(['gws']);
    expect(result.deregistered).toBe(0);
    expect(result.registered).toBe(0);
    // Bestehender Wrapper bleibt + Cache unveraendert.
    expect(toolRegistry.has('gws.calendar.list')).toBe(true);
    expect([...cache.getForServer('gws')]).toEqual(['gws.calendar.list']);
  });

  it('honours `only` filter and ignores unaffected servers', async () => {
    const utils = makeCfg('utils', [{ name: 'now', description: 'd' }]);
    const gws = makeCfg('gws', [{ name: 'calendar.list', description: 'd' }]);
    const registry = makeStubRegistry([utils, gws]);
    const toolRegistry = new ToolRegistry();
    const cache = new SubMcpWrappersCache();

    let calls = 0;
    const fakeFetch: typeof fetch = async (url) => {
      calls += 1;
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        result: {
          tools: String(url).includes('utils')
            ? [{ name: 'now', description: 'd' }]
            : [{ name: 'calendar.list', description: 'd' }],
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const forwarder = new SubMcpForwarder({ registry, fetchImpl: fakeFetch });
    const result = await applyGatewayDiscovery({
      registry,
      toolRegistry,
      forwarder,
      config: TEST_CONFIG,
      cache,
      fetchImpl: fakeFetch,
      only: ['utils'],
    });
    expect(calls).toBe(1);
    expect(result.perSubMcp.get('utils')).toBe(1);
    expect(result.perSubMcp.has('gws')).toBe(false);
    expect(toolRegistry.has('utils.now')).toBe(true);
    expect(toolRegistry.has('gws.calendar.list')).toBe(false);
  });
});
