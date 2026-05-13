/**
 * FederatedSearchService — Search ueber alle kinds via KnowledgeService.
 *
 * Plan-Ref: PLAN-architecture-v1.md §7 (Search-Surface). Portiert von
 * mcp-approval/src/tools/search.ts.
 *
 * Architektur: alle User-Content-Storage lebt in mcp-knowledge2. Die
 * federated-search-Surface ist ein duenner Wrapper um
 * `KnowledgeService.search({kinds, query, limit})` — die eigentliche
 * Hybrid-Search (FTS + Vectorize, mit RRF-Fusion bge-m3) ist KC2-internal.
 *
 * Sub-Doc-Annotation: ein Hit kann ein doc sein, das als Resource an
 * mehrere skills haengt. Der Caller will sehen "wo wird dieses doc gebraucht?"
 * → `used_by[]` (max 2 + `used_by_truncated_count`). Wir berechnen das hier
 * per-Hit via `KnowledgeService.docUsages` — N+1, aber nur fuer doc-Hits in
 * der Result-Liste (typisch < 20).
 *
 * IPI-Boundary: User-Content (doc/memo bodies & snippets) — der Tool-Output
 * passiert den IPI-Filter im Tool-Layer (registry.dispatch → ipiFilter).
 * Hier nur die Daten-Abfrage.
 */
import type { KnowledgeService } from './knowledge.js';
import type { SearchHit } from '@mcp-approval2/adapters';

export type KnowledgeKind = 'doc' | 'skill' | 'app' | 'memo';

export interface FederatedSearchArgs {
  readonly userId: string;
  readonly query: string;
  readonly kinds?: ReadonlyArray<KnowledgeKind>;
  readonly limit?: number;
  /** Default true — annotate doc-hits with used_by[] from skills. */
  readonly include_subdocs?: boolean;
}

export interface FederatedSearchHit extends SearchHit {
  /** Skill-IDs that reference this doc (max 2, oldest first). */
  used_by?: ReadonlyArray<{ kind: 'skill'; id: string; title: string | null }>;
  used_by_truncated_count?: number;
}

export interface FederatedSearchResult {
  readonly hits: ReadonlyArray<FederatedSearchHit>;
  readonly alt?: ReadonlyArray<string>;
}

export interface FederatedSearchService {
  search(args: FederatedSearchArgs): Promise<FederatedSearchResult>;
}

export interface FederatedSearchServiceOptions {
  readonly knowledge: KnowledgeService;
}

export function createFederatedSearchService(
  opts: FederatedSearchServiceOptions,
): FederatedSearchService {
  const { knowledge } = opts;

  return {
    async search(args): Promise<FederatedSearchResult> {
      const searchArgs: Parameters<KnowledgeService['search']>[0] = {
        userId: args.userId,
        query: args.query,
      };
      if (args.kinds && args.kinds.length > 0) {
        (searchArgs as { kinds?: ReadonlyArray<KnowledgeKind> }).kinds = args.kinds;
      }
      if (args.limit !== undefined) {
        (searchArgs as { limit?: number }).limit = args.limit;
      }
      const rawHits = await knowledge.search(searchArgs);
      const includeSubdocs = args.include_subdocs !== false;

      if (!includeSubdocs) {
        return { hits: rawHits as ReadonlyArray<FederatedSearchHit> };
      }

      // Per-doc-Hit: compute used_by. N+1 — acceptable while result-page <= 20.
      const annotated: FederatedSearchHit[] = [];
      for (const h of rawHits) {
        if (h.kind !== 'doc') {
          annotated.push(h);
          continue;
        }
        try {
          const usages = await knowledge.docUsages({ userId: args.userId, docId: h.id });
          const incoming = usages.incoming;
          const truncated = Math.max(0, incoming.length - 2);
          const out: FederatedSearchHit = { ...h };
          if (incoming.length > 0) {
            out.used_by = incoming.slice(0, 2);
            if (truncated > 0) out.used_by_truncated_count = truncated;
          }
          annotated.push(out);
        } catch {
          // Soft-fail: KC2 unavailable for usages → don't break the search.
          annotated.push(h);
        }
      }

      const result: FederatedSearchResult = {
        hits: annotated,
      };
      // Hint when result-page is small + capability_search would help.
      const looksLikeCapability =
        annotated.length === 0 && /\b(how|use|capability|tool|skill)\b/i.test(args.query);
      if (looksLikeCapability) {
        return { ...result, alt: ['try capability_search for tool+skill discovery'] };
      }
      return result;
    },
  };
}
