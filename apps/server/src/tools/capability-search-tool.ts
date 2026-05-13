/**
 * capability_search — Tool-Wrapper auf CapabilitySearchService.
 *
 * Plan-Ref: PLAN-architecture-v1.md §7. Cross-promotes von `search` (user-content)
 * wenn die Query nach Capability/How-to klingt.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';
import type {
  CapabilitySearchService,
  CapabilitySearchResult,
} from '../services/capability-search.js';

export const CapabilitySearchInput = z
  .object({
    query: z.string().min(1).max(1024),
    tool_quota: z.number().int().min(0).max(50).optional(),
    skill_quota: z.number().int().min(0).max(50).optional(),
  })
  .strict();
export type CapabilitySearchInputT = z.infer<typeof CapabilitySearchInput>;

export interface CapabilitySearchToolDeps {
  readonly capabilitySearch: CapabilitySearchService;
}

export function makeCapabilitySearchTool(
  deps: CapabilitySearchToolDeps,
): Tool<CapabilitySearchInputT, CapabilitySearchResult> {
  return {
    name: 'capability_search',
    description:
      'Unified tool+skill discovery via RRF fusion. Use when you don\'t know whether the right answer is a tool (atomic action) or a skill (packaged how-to).',
    sensitivity: 'read',
    inputSchema: CapabilitySearchInput,
    async execute(ctx: ToolContext, input): Promise<CapabilitySearchResult> {
      const args: Parameters<CapabilitySearchService['search']>[0] = {
        userId: ctx.userId,
        query: input.query,
      };
      if (input.tool_quota !== undefined) {
        (args as { toolQuota?: number }).toolQuota = input.tool_quota;
      }
      if (input.skill_quota !== undefined) {
        (args as { skillQuota?: number }).skillQuota = input.skill_quota;
      }
      return deps.capabilitySearch.search(args);
    },
  };
}
