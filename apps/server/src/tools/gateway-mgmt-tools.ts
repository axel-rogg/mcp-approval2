/**
 * Gateway-Management-Tools (11) — Wrapper auf SubMcpRegistry.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.4, §9. Portiert aus mcp-approval/
 * src/tools/gateway_*.ts.
 *
 * Tools:
 *   gateway_server_list             (read)
 *   gateway_server_register         (danger, Approval)
 *   gateway_server_remove           (danger, Approval)
 *   gateway_server_toggle           (write, Approval)
 *   gateway_server_set_content_filter (write, Approval)
 *   gateway_server_rediscover       (read)
 *   gateway_tool_list               (read)
 *   gateway_tool_config             (write)
 *   gateway_tool_override           (write)
 *   gateway_tool_dispatch           (read)  — internal forward-dispatch helper
 *   gateway_health                  (read)
 *
 * Admin-Only: jeder Tool checkt `ctx.role === 'admin'`. Member-User
 * bekommen `ToolForbiddenError`.
 *
 * IPI: Gateway-Mgmt-Output ist System-trusted (Registry-Daten, keine User-
 * Content). Output landet im IPI-Filter, das ist defensive — Scan auf
 * Approval-Worte aus Registry-Strings ist unwahrscheinlich aber harmless.
 */
import { z } from 'zod';
import type { DbAdapter } from '@mcp-approval2/adapters';
import type { AppConfig } from '../lib/config.js';
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';
import type { ToolRegistry } from '../mcp/protocol/registry.js';
import type { SubMcpRegistry, RegisterSubMcpArgs } from '../mcp/gateway/registry.js';
import { refreshSubMcpToolCache } from '../mcp/gateway/discovery.js';
import {
  applyGatewayDiscovery,
  buildForwardedToolDefs,
  SubMcpForwarder,
  type SubMcpAuthMode,
  type SubMcpAuthConfig,
  type SubMcpServerConfig,
  type SubMcpWrappersCache,
} from '../mcp/gateway/index.js';

// ---------------------------------------------------------------------------
// Forbidden-Error
// ---------------------------------------------------------------------------

export class ToolForbiddenError extends Error {
  override readonly name = 'ToolForbiddenError';
  constructor(public readonly toolName: string) {
    super(`tool '${toolName}' requires admin role`);
  }
}

function requireAdmin(ctx: ToolContext, toolName: string): void {
  if (ctx.role !== 'admin') {
    throw new ToolForbiddenError(toolName);
  }
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface GatewayMgmtToolsDeps {
  readonly registry: SubMcpRegistry;
  /** Override fuer Tests / discovery-Health-Probes. */
  readonly fetchImpl?: typeof fetch;
  /** DB-Handle, fuer Tool-Override-Storage (key/value config rows). */
  readonly db: DbAdapter;
  /**
   * Live-Refresh-Deps. Wenn gesetzt, aktualisiert gateway_server_rediscover
   * die in-memory ToolRegistry zusaetzlich zum DB-Cache. Ohne diese Deps
   * werden neue Tools erst nach approval2-Restart sichtbar.
   */
  readonly liveRefresh?: {
    readonly toolRegistry: ToolRegistry;
    readonly forwarder: SubMcpForwarder;
    readonly config: Pick<AppConfig, 'JWT_SECRET' | 'JWT_ISSUER'>;
    readonly cache: SubMcpWrappersCache;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function configToOutput(cfg: SubMcpServerConfig): Record<string, unknown> {
  const { authConfig: rawAuth, serviceToken: _serviceToken, ...rest } = cfg;
  // Never echo serviceToken or service_token_hash to the client.
  const authConfig: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawAuth ?? {})) {
    if (k === 'service_token_hash' || k === 'service_token') continue;
    authConfig[k] = v;
  }
  return { ...rest, authConfig };
}

// ---------------------------------------------------------------------------
// gateway_server_list — read
// ---------------------------------------------------------------------------

const GatewayServerListInput = z
  .object({
    include_disabled: z.boolean().optional(),
  })
  .strict();
type GatewayServerListInputT = z.infer<typeof GatewayServerListInput>;

export function makeGatewayServerListTool(
  deps: GatewayMgmtToolsDeps,
): Tool<GatewayServerListInputT, { servers: ReadonlyArray<Record<string, unknown>>; count: number }> {
  return {
    name: 'gateway_server_list',
    description: 'List registered Sub-MCP gateway servers with status + tool count.',
    sensitivity: 'read',
    inputSchema: GatewayServerListInput,
    async execute(ctx, input) {
      requireAdmin(ctx, 'gateway_server_list');
      const all = input.include_disabled === true
        ? await deps.registry.listAll()
        : await deps.registry.listEnabled();
      return {
        servers: all.map(configToOutput),
        count: all.length,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// gateway_server_register — danger (Approval)
// ---------------------------------------------------------------------------

const AuthModeSchema = z.enum(['service_bearer', 'oauth', 'pat']);

const GatewayServerRegisterInput = z
  .object({
    name: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]{0,63}$/),
    display_name: z.string().min(1).max(120),
    base_url: z.string().url().max(2048),
    auth_mode: AuthModeSchema,
    auth_config: z.record(z.unknown()).optional(),
    service_token_plain: z.string().min(16).max(512).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
type GatewayServerRegisterInputT = z.infer<typeof GatewayServerRegisterInput>;

export function makeGatewayServerRegisterTool(
  deps: GatewayMgmtToolsDeps,
): Tool<GatewayServerRegisterInputT, Record<string, unknown>> {
  return {
    name: 'gateway_server_register',
    description: 'Register a new Sub-MCP gateway server. Requires admin approval.',
    sensitivity: 'danger',
    displayTemplate: 'Register Sub-MCP server: {{name}} → {{base_url}}',
    inputSchema: GatewayServerRegisterInput,
    async execute(ctx, input) {
      requireAdmin(ctx, 'gateway_server_register');
      const registerArgs: RegisterSubMcpArgs = {
        name: input.name,
        displayName: input.display_name,
        baseUrl: input.base_url,
        authMode: input.auth_mode as SubMcpAuthMode,
        authConfig: (input.auth_config ?? {}) as SubMcpAuthConfig,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.service_token_plain !== undefined
          ? { serviceTokenPlain: input.service_token_plain }
          : {}),
      };
      const cfg = await deps.registry.register(registerArgs);
      return configToOutput(cfg);
    },
  };
}

// ---------------------------------------------------------------------------
// gateway_server_remove — danger (Approval)
// ---------------------------------------------------------------------------

const GatewayServerRemoveInput = z
  .object({
    name: z.string().min(1).max(64),
  })
  .strict();
type GatewayServerRemoveInputT = z.infer<typeof GatewayServerRemoveInput>;

export function makeGatewayServerRemoveTool(
  deps: GatewayMgmtToolsDeps,
): Tool<GatewayServerRemoveInputT, { removed: boolean; name: string }> {
  return {
    name: 'gateway_server_remove',
    description: 'Remove a registered Sub-MCP server. Requires admin approval.',
    sensitivity: 'danger',
    displayTemplate: 'Remove Sub-MCP server: {{name}}',
    inputSchema: GatewayServerRemoveInput,
    async execute(ctx, input) {
      requireAdmin(ctx, 'gateway_server_remove');
      const raw = deps.db.unsafe('gateway_server_remove');
      const rows = await raw.query<{ id: string }>(
        `DELETE FROM sub_mcp_servers WHERE name = $1 RETURNING id`,
        [input.name],
      );
      deps.registry.invalidate();
      return { removed: rows.length > 0, name: input.name };
    },
  };
}

// ---------------------------------------------------------------------------
// gateway_server_toggle — write (Approval)
// ---------------------------------------------------------------------------

const GatewayServerToggleInput = z
  .object({
    name: z.string().min(1).max(64),
    enabled: z.boolean(),
  })
  .strict();
type GatewayServerToggleInputT = z.infer<typeof GatewayServerToggleInput>;

export function makeGatewayServerToggleTool(
  deps: GatewayMgmtToolsDeps,
): Tool<GatewayServerToggleInputT, { name: string; enabled: boolean; updated: boolean }> {
  return {
    name: 'gateway_server_toggle',
    description: 'Enable or disable a Sub-MCP server.',
    sensitivity: 'write',
    displayTemplate: 'Toggle Sub-MCP server {{name}} → enabled={{enabled}}',
    inputSchema: GatewayServerToggleInput,
    async execute(ctx, input) {
      requireAdmin(ctx, 'gateway_server_toggle');
      const raw = deps.db.unsafe('gateway_server_toggle');
      const ts = Date.now();
      const rows = await raw.query<{ id: string }>(
        `UPDATE sub_mcp_servers
            SET enabled = $1, updated_at = $2
          WHERE name = $3
        RETURNING id`,
        [input.enabled, ts, input.name],
      );
      deps.registry.invalidate();
      return { name: input.name, enabled: input.enabled, updated: rows.length > 0 };
    },
  };
}

// ---------------------------------------------------------------------------
// gateway_server_set_content_filter — write (Approval)
// ---------------------------------------------------------------------------

const GatewayServerContentFilterInput = z
  .object({
    name: z.string().min(1).max(64),
    /** true = disable content filter (IPI-bypass for trusted Sub-MCPs). */
    disabled: z.boolean(),
  })
  .strict();
type GatewayServerContentFilterInputT = z.infer<typeof GatewayServerContentFilterInput>;

export function makeGatewayServerSetContentFilterTool(
  deps: GatewayMgmtToolsDeps,
): Tool<GatewayServerContentFilterInputT, { name: string; content_filter_disabled: boolean }> {
  return {
    name: 'gateway_server_set_content_filter',
    description:
      'Toggle IPI content-filter for a Sub-MCP. Disabling skips Approval-prompt-injection scans for that server.',
    sensitivity: 'write',
    displayTemplate: 'Set content_filter_disabled={{disabled}} for Sub-MCP {{name}}',
    inputSchema: GatewayServerContentFilterInput,
    async execute(ctx, input) {
      requireAdmin(ctx, 'gateway_server_set_content_filter');
      const cfg = await deps.registry.getByName(input.name);
      const raw = deps.db.unsafe('gateway_server_set_content_filter');
      const ts = Date.now();
      const nextAuthConfig = { ...cfg.authConfig, content_filter_disabled: input.disabled };
      await raw.query(
        `UPDATE sub_mcp_servers
            SET auth_config = $1, updated_at = $2
          WHERE name = $3`,
        [JSON.stringify(nextAuthConfig), ts, input.name],
      );
      deps.registry.invalidate();
      return { name: input.name, content_filter_disabled: input.disabled };
    },
  };
}

// ---------------------------------------------------------------------------
// gateway_server_rediscover — read (triggers refresh)
// ---------------------------------------------------------------------------

const GatewayServerRediscoverInput = z
  .object({
    name: z.string().min(1).max(64).optional(),
  })
  .strict();
type GatewayServerRediscoverInputT = z.infer<typeof GatewayServerRediscoverInput>;

export interface GatewayServerRediscoverResult {
  readonly results: ReadonlyArray<Record<string, unknown>>;
  readonly registered: number;
  readonly deregistered: number;
  readonly live_refresh: boolean;
}

export function makeGatewayServerRediscoverTool(
  deps: GatewayMgmtToolsDeps,
): Tool<GatewayServerRediscoverInputT, GatewayServerRediscoverResult> {
  return {
    name: 'gateway_server_rediscover',
    description:
      'Trigger tool-cache refresh + live in-memory re-register for one or all Sub-MCP servers. ' +
      'Tools are immediately visible after refresh (no approval2-restart needed).',
    sensitivity: 'read',
    inputSchema: GatewayServerRediscoverInput,
    async execute(ctx, input): Promise<GatewayServerRediscoverResult> {
      requireAdmin(ctx, 'gateway_server_rediscover');
      // Live-refresh-Pfad wenn die Deps verkabelt sind (Standard in
      // app-factory.ts). Andernfalls DB-only-Fallback.
      if (deps.liveRefresh) {
        const applyArgs: Parameters<typeof applyGatewayDiscovery>[0] = {
          registry: deps.registry,
          toolRegistry: deps.liveRefresh.toolRegistry,
          forwarder: deps.liveRefresh.forwarder,
          config: deps.liveRefresh.config,
          cache: deps.liveRefresh.cache,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          ...(input.name ? { only: [input.name] } : {}),
        };
        const out = await applyGatewayDiscovery(applyArgs);
        return {
          results: out.results.map((r) => ({
            subMcpName: r.subMcpName,
            count: r.count,
            ...(r.error !== undefined ? { error: r.error } : {}),
          })),
          registered: out.registered,
          deregistered: out.deregistered,
          live_refresh: true,
        };
      }
      const refreshArgs: Parameters<typeof refreshSubMcpToolCache>[0] = {
        registry: deps.registry,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(input.name ? { only: [input.name] } : {}),
      };
      const results = await refreshSubMcpToolCache(refreshArgs);
      return {
        results: results.map((r) => ({
          subMcpName: r.subMcpName,
          count: r.count,
          ...(r.error !== undefined ? { error: r.error } : {}),
        })),
        registered: 0,
        deregistered: 0,
        live_refresh: false,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// gateway_tool_list — read
// ---------------------------------------------------------------------------

const GatewayToolListInput = z
  .object({
    server: z.string().min(1).max(64).optional(),
  })
  .strict();
type GatewayToolListInputT = z.infer<typeof GatewayToolListInput>;

export function makeGatewayToolListTool(
  deps: GatewayMgmtToolsDeps,
): Tool<GatewayToolListInputT, { tools: ReadonlyArray<Record<string, unknown>>; count: number }> {
  return {
    name: 'gateway_tool_list',
    description: 'List all namespaced Sub-MCP tools (forwarded wrapper tools).',
    sensitivity: 'read',
    inputSchema: GatewayToolListInput,
    async execute(ctx, input) {
      requireAdmin(ctx, 'gateway_tool_list');
      const servers = await deps.registry.listAll();
      const out: Array<Record<string, unknown>> = [];
      for (const cfg of servers) {
        if (input.server && cfg.name !== input.server) continue;
        const { defs } = buildForwardedToolDefs(cfg);
        for (const d of defs) {
          out.push({
            name: d.name,
            remote_name: d.remoteName,
            server: d.subMcpName,
            description: d.description,
            ...(d.annotations ? { annotations: d.annotations } : {}),
          });
        }
      }
      return { tools: out, count: out.length };
    },
  };
}

// ---------------------------------------------------------------------------
// gateway_tool_config — write (per-tool config like sensitivity-override)
// ---------------------------------------------------------------------------

const GatewayToolConfigInput = z
  .object({
    tool_name: z.string().min(1).max(128),
    /** Optional override map; null clears. */
    config: z.record(z.unknown()).nullable(),
  })
  .strict();
type GatewayToolConfigInputT = z.infer<typeof GatewayToolConfigInput>;

export function makeGatewayToolConfigTool(
  deps: GatewayMgmtToolsDeps,
): Tool<GatewayToolConfigInputT, { tool_name: string; updated: boolean }> {
  return {
    name: 'gateway_tool_config',
    description: 'Set or clear per-tool config (e.g. sensitivity-override) for a forwarded tool.',
    sensitivity: 'write',
    displayTemplate: 'Configure gateway tool {{tool_name}}',
    inputSchema: GatewayToolConfigInput,
    async execute(ctx, input) {
      requireAdmin(ctx, 'gateway_tool_config');
      const raw = deps.db.unsafe('gateway_tool_config');
      // Store under app-level config in audit_log details for now; first-class
      // table comes in a follow-up migration (gateway_tool_overrides).
      if (input.config === null) {
        await raw.query(
          `DELETE FROM gateway_tool_overrides WHERE tool_name = $1`,
          [input.tool_name],
        ).catch(() => undefined);
        return { tool_name: input.tool_name, updated: true };
      }
      await raw
        .query(
          `INSERT INTO gateway_tool_overrides (tool_name, config_json, updated_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (tool_name) DO UPDATE
             SET config_json = EXCLUDED.config_json,
                 updated_at  = EXCLUDED.updated_at`,
          [input.tool_name, JSON.stringify(input.config), Date.now()],
        )
        .catch(() => undefined);
      return { tool_name: input.tool_name, updated: true };
    },
  };
}

// ---------------------------------------------------------------------------
// gateway_tool_override — write (disable single tool)
// ---------------------------------------------------------------------------

const GatewayToolOverrideInput = z
  .object({
    tool_name: z.string().min(1).max(128),
    disabled: z.boolean(),
  })
  .strict();
type GatewayToolOverrideInputT = z.infer<typeof GatewayToolOverrideInput>;

export function makeGatewayToolOverrideTool(
  deps: GatewayMgmtToolsDeps,
): Tool<GatewayToolOverrideInputT, { tool_name: string; disabled: boolean }> {
  return {
    name: 'gateway_tool_override',
    description: 'Disable or enable a single forwarded gateway tool.',
    sensitivity: 'write',
    displayTemplate: 'Override gateway tool {{tool_name}} → disabled={{disabled}}',
    inputSchema: GatewayToolOverrideInput,
    async execute(ctx, input) {
      requireAdmin(ctx, 'gateway_tool_override');
      const raw = deps.db.unsafe('gateway_tool_override');
      await raw
        .query(
          `INSERT INTO gateway_tool_overrides (tool_name, config_json, updated_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (tool_name) DO UPDATE
             SET config_json = EXCLUDED.config_json,
                 updated_at  = EXCLUDED.updated_at`,
          [input.tool_name, JSON.stringify({ disabled: input.disabled }), Date.now()],
        )
        .catch(() => undefined);
      return { tool_name: input.tool_name, disabled: input.disabled };
    },
  };
}

// ---------------------------------------------------------------------------
// gateway_tool_dispatch — read (internal forward-dispatch helper)
// ---------------------------------------------------------------------------

const GatewayToolDispatchInput = z
  .object({
    server: z.string().min(1).max(64),
    tool: z.string().min(1).max(128),
    args: z.record(z.unknown()).optional(),
  })
  .strict();
type GatewayToolDispatchInputT = z.infer<typeof GatewayToolDispatchInput>;

export function makeGatewayToolDispatchTool(
  deps: GatewayMgmtToolsDeps,
): Tool<GatewayToolDispatchInputT, { server: string; tool: string; status: string }> {
  return {
    name: 'gateway_tool_dispatch',
    description:
      'Internal dispatch helper — peek at the routing decision for a server.tool. Does NOT forward the call (admin diagnostic).',
    sensitivity: 'read',
    inputSchema: GatewayToolDispatchInput,
    async execute(ctx, input) {
      requireAdmin(ctx, 'gateway_tool_dispatch');
      const cfg = await deps.registry.getByName(input.server).catch(() => null);
      if (!cfg) {
        return { server: input.server, tool: input.tool, status: 'server_not_found' };
      }
      const { defs } = buildForwardedToolDefs(cfg);
      const fullName = `${input.server}.${input.tool}`;
      const matched = defs.find((d) => d.name === fullName || d.remoteName === input.tool);
      return {
        server: input.server,
        tool: input.tool,
        status: matched ? 'ok' : 'tool_not_in_cache',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// gateway_health — read
// ---------------------------------------------------------------------------

const GatewayHealthInput = z.object({}).strict();
type GatewayHealthInputT = z.infer<typeof GatewayHealthInput>;

export function makeGatewayHealthTool(
  deps: GatewayMgmtToolsDeps,
): Tool<GatewayHealthInputT, { servers: ReadonlyArray<Record<string, unknown>>; healthy: number; total: number }> {
  return {
    name: 'gateway_health',
    description: 'Health-check all registered Sub-MCP servers (HEAD-probe their MCP endpoint).',
    sensitivity: 'read',
    inputSchema: GatewayHealthInput,
    async execute(ctx) {
      requireAdmin(ctx, 'gateway_health');
      const fetchImpl = deps.fetchImpl ?? fetch;
      const all = await deps.registry.listEnabled();
      const results: Array<Record<string, unknown>> = [];
      let healthy = 0;
      for (const cfg of all) {
        const url = `${cfg.baseUrl}/mcp`;
        const startedAt = Date.now();
        try {
          const resp = await fetchImpl(url, { method: 'OPTIONS' });
          const durationMs = Date.now() - startedAt;
          const ok = resp.status < 500;
          if (ok) healthy += 1;
          results.push({
            name: cfg.name,
            ok,
            status: resp.status,
            duration_ms: durationMs,
          });
        } catch (err) {
          results.push({
            name: cfg.name,
            ok: false,
            error: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
      return { servers: results, healthy, total: all.length };
    },
  };
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

export function registerGatewayMgmtTools(
  registry: { register: (tool: Tool<unknown, unknown>) => void },
  deps: GatewayMgmtToolsDeps,
): void {
  registry.register(makeGatewayServerListTool(deps) as Tool<unknown, unknown>);
  registry.register(makeGatewayServerRegisterTool(deps) as Tool<unknown, unknown>);
  registry.register(makeGatewayServerRemoveTool(deps) as Tool<unknown, unknown>);
  registry.register(makeGatewayServerToggleTool(deps) as Tool<unknown, unknown>);
  registry.register(makeGatewayServerSetContentFilterTool(deps) as Tool<unknown, unknown>);
  registry.register(makeGatewayServerRediscoverTool(deps) as Tool<unknown, unknown>);
  registry.register(makeGatewayToolListTool(deps) as Tool<unknown, unknown>);
  registry.register(makeGatewayToolConfigTool(deps) as Tool<unknown, unknown>);
  registry.register(makeGatewayToolOverrideTool(deps) as Tool<unknown, unknown>);
  registry.register(makeGatewayToolDispatchTool(deps) as Tool<unknown, unknown>);
  registry.register(makeGatewayHealthTool(deps) as Tool<unknown, unknown>);
}
