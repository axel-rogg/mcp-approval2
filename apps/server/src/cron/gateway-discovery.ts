/**
 * Cron-Task: Sub-MCP-Tool-Cache + in-memory Wrapper-Tools refreshen.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.4 (Sub-MCP-Discovery), §9.
 *
 * Workflow:
 *   1. Pro enabled Sub-MCP `tools/list` ueber HTTPS holen (refresh.ts /
 *      refreshSubMcpToolCache via applyGatewayDiscovery).
 *   2. DB-`tools_cache` updaten.
 *   3. Wenn `subMcpWrappers`-Deps vorhanden: in-memory ToolRegistry
 *      live-aktualisieren (de-register old, re-register new). Analog
 *      kc-manifest-refresh.
 *
 * Fail-soft pro Server — ein kaputter Sub-MCP stoppt den ganzen Refresh
 * nicht. Audit-Event wird mit refreshed/errors/total-Counts emittiert.
 */
import type { CronDeps, TaskResult } from './index.js';
import { emitAudit } from '../services/audit.js';
import { applyGatewayDiscovery } from '../mcp/gateway/refresh.js';
import { refreshSubMcpToolCache } from '../mcp/gateway/discovery.js';

export async function runGatewayDiscovery(deps: CronDeps): Promise<TaskResult> {
  if (!deps.subMcpRegistry) {
    await emitAudit(deps.db, {
      action: 'cron.gateway_discovery',
      actorUserId: null,
      result: 'noop',
      details: { reason: 'sub_mcp_registry_unavailable' },
    });
    return { refreshed: 0, errors: 0 };
  }

  // Live-refresh-Pfad: deps.subMcpWrappers vorhanden → applyGatewayDiscovery
  // updated DB + ToolRegistry atomisch (de-register-old, register-new).
  if (deps.subMcpWrappers) {
    const applyArgs: Parameters<typeof applyGatewayDiscovery>[0] = {
      registry: deps.subMcpRegistry,
      toolRegistry: deps.subMcpWrappers.toolRegistry,
      forwarder: deps.subMcpWrappers.forwarder,
      config: deps.subMcpWrappers.config,
      cache: deps.subMcpWrappers.cache,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    };
    const result = await applyGatewayDiscovery(applyArgs);
    const refreshed = result.results.filter((r) => !r.error).length;
    const errors = result.failed.length;
    const totalTools = result.results.reduce((a, r) => a + r.count, 0);
    await emitAudit(deps.db, {
      action: 'cron.gateway_discovery',
      actorUserId: null,
      result: errors === 0 ? 'success' : refreshed > 0 ? 'success' : 'failure',
      details: {
        refreshed,
        errors,
        total_tools: totalTools,
        registered: result.registered,
        deregistered: result.deregistered,
        live_refresh: true,
      },
    });
    return {
      refreshed,
      errors,
      total_tools: totalTools,
      registered: result.registered,
      deregistered: result.deregistered,
      results: result.results,
    };
  }

  // Fallback: DB-only refresh wenn keine wrapper-deps. Neue Tools sind
  // erst nach approval2-Restart sichtbar. Halbierte Funktion — App-Factory
  // sollte subMcpWrappers immer wiren.
  const refreshArgs: Parameters<typeof refreshSubMcpToolCache>[0] = {
    registry: deps.subMcpRegistry,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  };
  const results = await refreshSubMcpToolCache(refreshArgs);
  let refreshed = 0;
  let errors = 0;
  let totalTools = 0;
  for (const r of results) {
    if (r.error) errors += 1;
    else refreshed += 1;
    totalTools += r.count;
  }
  await emitAudit(deps.db, {
    action: 'cron.gateway_discovery',
    actorUserId: null,
    result: errors === 0 ? 'success' : refreshed > 0 ? 'success' : 'failure',
    details: { refreshed, errors, total_tools: totalTools, live_refresh: false },
  });
  return { refreshed, errors, total_tools: totalTools, results };
}
