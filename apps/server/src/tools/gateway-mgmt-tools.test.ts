/**
 * gateway-mgmt-tools tests.
 *
 *   - admin-only check (member → ToolForbiddenError)
 *   - read-tools succeed for admin
 *   - write-tools require approval (Registry-Dispatch wirft ApprovalRequiredError)
 */
import { describe, expect, it, vi } from 'vitest';
import type { DbAdapter } from '@mcp-approval2/adapters';
import {
  ApprovalRequiredError,
  ToolRegistry,
} from '../mcp/protocol/registry.js';
import type { AuditService, ToolContext } from '../mcp/protocol/tool.js';
import type { SubMcpRegistry, SubMcpServerConfig } from '../mcp/gateway/index.js';
import {
  ToolForbiddenError,
  makeGatewayServerListTool,
  makeGatewayServerToggleTool,
  makeGatewayHealthTool,
  makeGatewayToolListTool,
  registerGatewayMgmtTools,
} from './gateway-mgmt-tools.js';

const USER_ID = '00000000-0000-0000-0000-000000000001';

function makeServerConfigStub(name = 'cf'): SubMcpServerConfig {
  return {
    id: 'srv-1',
    name,
    displayName: 'Test',
    baseUrl: 'https://example.com',
    authMode: 'service_bearer',
    authConfig: { service_token_hash: 'deadbeef' },
    enabled: true,
    serviceToken: 'plain-token',
    toolsCache: [
      {
        name: 'echo',
        description: 'echoes',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    toolsCachedAt: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeRegistryStub(servers: SubMcpServerConfig[] = []): SubMcpRegistry {
  const map = new Map(servers.map((s) => [s.name, s]));
  return {
    async getByName(name) {
      const cfg = map.get(name);
      if (!cfg) throw new Error('not found');
      return cfg;
    },
    async listAll() {
      return [...map.values()];
    },
    async listEnabled() {
      return [...map.values()].filter((c) => c.enabled);
    },
    async updateToolsCache() {},
    async verifyServiceToken() {
      return null;
    },
    async register(args) {
      const cfg: SubMcpServerConfig = {
        id: 'new-id',
        name: args.name,
        displayName: args.displayName,
        baseUrl: args.baseUrl,
        authMode: args.authMode,
        authConfig: args.authConfig,
        enabled: args.enabled ?? true,
        serviceToken: null,
        toolsCache: null,
        toolsCachedAt: null,
        createdAt: 1,
        updatedAt: 1,
      };
      map.set(args.name, cfg);
      return cfg;
    },
    invalidate() {},
  };
}

function makeDbStub(): DbAdapter {
  const scoped = {
    async query() {
      return [];
    },
    drizzle: {} as unknown,
  };
  return {
    dialect: 'postgres' as const,
    async scoped() {
      return { ...scoped, userId: 'stub', dialect: 'postgres' as const };
    },
    unsafe() {
      return { ...scoped, dialect: 'postgres' as const };
    },
    async transaction<T>(_uid: string, fn: (sc: typeof scoped) => Promise<T>): Promise<T> {
      return fn(scoped);
    },
    async migrate() {},
    async close() {},
  } as unknown as DbAdapter;
}

function makeAuditStub(): AuditService {
  return { async emit() {} };
}

function makeCtx(role: 'admin' | 'member', db: DbAdapter): ToolContext {
  return {
    userId: USER_ID,
    email: 'a@example.com',
    role,
    requestId: 'req-1',
    audit: makeAuditStub(),
    db,
    signal: new AbortController().signal,
  };
}

describe('gateway-mgmt-tools', () => {
  it('gateway_server_list requires admin role', async () => {
    const db = makeDbStub();
    const registry = makeRegistryStub([makeServerConfigStub()]);
    const tool = makeGatewayServerListTool({ registry, db });
    await expect(tool.execute(makeCtx('member', db), {})).rejects.toBeInstanceOf(
      ToolForbiddenError,
    );
  });

  it('gateway_server_list returns servers without secrets', async () => {
    const db = makeDbStub();
    const registry = makeRegistryStub([makeServerConfigStub()]);
    const tool = makeGatewayServerListTool({ registry, db });
    const out = await tool.execute(makeCtx('admin', db), {});
    expect(out.count).toBe(1);
    const first = out.servers[0] as Record<string, unknown>;
    expect(first['name']).toBe('cf');
    // Service-Token and hash never leak.
    expect((first['authConfig'] as Record<string, unknown>)['service_token_hash']).toBeUndefined();
    expect(first['serviceToken']).toBeUndefined();
  });

  it('gateway_tool_list expands forwarded tools from cache', async () => {
    const db = makeDbStub();
    const registry = makeRegistryStub([makeServerConfigStub('cf')]);
    const tool = makeGatewayToolListTool({ registry, db });
    const out = await tool.execute(makeCtx('admin', db), {});
    expect(out.count).toBe(1);
    expect((out.tools[0] as Record<string, unknown>)['name']).toBe('cf.echo');
  });

  it('gateway_health probes baseUrl', async () => {
    const db = makeDbStub();
    const registry = makeRegistryStub([makeServerConfigStub()]);
    const fakeFetch = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const tool = makeGatewayHealthTool({ registry, db, fetchImpl: fakeFetch });
    const out = await tool.execute(makeCtx('admin', db), {});
    expect(out.total).toBe(1);
    expect(out.healthy).toBe(1);
    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it('gateway_server_toggle is write-sensitivity (Approval-required)', async () => {
    const db = makeDbStub();
    const registry = makeRegistryStub([makeServerConfigStub()]);
    const tool = makeGatewayServerToggleTool({ registry, db });
    expect(tool.sensitivity).toBe('write');

    const reg = new ToolRegistry();
    reg.register(tool);
    await expect(
      reg.dispatch({
        name: 'gateway_server_toggle',
        input: { name: 'cf', enabled: false },
        ctx: makeCtx('admin', db),
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('registerGatewayMgmtTools registers 11 tools', () => {
    const db = makeDbStub();
    const registry = makeRegistryStub();
    const reg = new ToolRegistry();
    registerGatewayMgmtTools(reg, { registry, db });
    expect(reg.size()).toBe(11);
  });
});
