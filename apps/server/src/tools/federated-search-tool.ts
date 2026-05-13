/**
 * search — Federated user-content search via FederatedSearchService.
 *
 * Plan-Ref: PLAN-architecture-v1.md §7.
 * IPI: User-Content surface — Output passiert den ipiFilter im Registry-Dispatch.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';
import type {
  FederatedSearchResult,
  FederatedSearchService,
} from '../services/federated-search.js';

const KnowledgeKind = z.enum(['doc', 'skill', 'app', 'memo']);

export const FederatedSearchInput = z
  .object({
    query: z.string().min(1).max(1024),
    kinds: z.array(KnowledgeKind).min(1).max(4).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    include_subdocs: z.boolean().optional(),
  })
  .strict();
export type FederatedSearchInputT = z.infer<typeof FederatedSearchInput>;

export interface FederatedSearchToolDeps {
  readonly federatedSearch: FederatedSearchService;
}

export function makeFederatedSearchTool(
  deps: FederatedSearchToolDeps,
): Tool<FederatedSearchInputT, FederatedSearchResult> {
  return {
    name: 'search',
    description:
      'Federated search across docs, skills, apps and memos (user content). Hybrid FTS + Vector via mcp-knowledge2.',
    sensitivity: 'read',
    inputSchema: FederatedSearchInput,
    async execute(ctx: ToolContext, input): Promise<FederatedSearchResult> {
      const args: Parameters<FederatedSearchService['search']>[0] = {
        userId: ctx.userId,
        query: input.query,
      };
      if (input.kinds !== undefined) {
        (args as { kinds?: ReadonlyArray<'doc' | 'skill' | 'app' | 'memo'> }).kinds = input.kinds;
      }
      if (input.limit !== undefined) {
        (args as { limit?: number }).limit = input.limit;
      }
      if (input.include_subdocs !== undefined) {
        (args as { include_subdocs?: boolean }).include_subdocs = input.include_subdocs;
      }
      return deps.federatedSearch.search(args);
    },
  };
}
