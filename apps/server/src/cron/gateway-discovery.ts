/**
 * Cron-Task: Sub-MCP-Tool-Cache refreshen.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.4 (Sub-MCP-Discovery), §9.
 *
 * Iteriert alle aktiven Sub-MCP-Server, ruft `tools/list` ab, schreibt in
 * `tools_cache`. Errors pro Server werden gesammelt, nicht thrown — wir wollen,
 * dass ein einzelner kaputter Sub-MCP nicht den ganzen Refresh stoppt.
 */
import type { CronDeps, TaskResult } from './index.js';
import { emitAudit } from '../services/audit.js';
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
    details: { refreshed, errors, total_tools: totalTools },
  });

  return { refreshed, errors, total_tools: totalTools, results };
}
