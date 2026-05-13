/**
 * Search-Score-Funktionen — RRF-Fusion + Hybrid-Score-Helper.
 *
 * Plan-Ref: PLAN-architecture-v1.md §7 (Search-Surface). Portiert von
 * mcp-approval/src/search/scorers.ts.
 *
 * Aktuell exportiert nur `scoreRRF` (von capability-search benoetigt); die
 * uebrigen Helper aus mcp-approval (bm25Map, scoreHybrid, scoreTimeDecay)
 * werden bei Bedarf in einem Folge-Commit eingefuegt.
 */

/**
 * Reciprocal Rank Fusion (Cormack et al. 2009).
 *
 * Production-state-of-the-art fuer Hybrid-Search-Merging wenn die Rank-Listen
 * auf inkompatiblen Score-Skalen leben (z.B. BM25 vs Cosine, oder tools_search
 * vs skills_search). Rank-basiert, daher score-skalen-agnostisch.
 *
 * Formel: RRF(d) = Σ_i (1 / (k + rank_i(d))) ueber alle Rank-Listen i, wobei
 * rank_i(d) die 1-basierte Position von d in Liste i ist (∞ wenn nicht
 * praesent → Beitrag = 0).
 *
 * k=60 ist der kanonische Default — robust ueber Domains, balanciert
 * early-rank-Dominanz vs tail-contribution.
 *
 * Output-Range: ~0 .. (rankLists.length / (k + 1)). Sortier-Order: descending.
 */
export function scoreRRF(
  rankLists: ReadonlyArray<ReadonlyMap<string, number>>,
  k = 60,
): Map<string, number> {
  const out = new Map<string, number>();
  const allIds = new Set<string>();
  for (const list of rankLists) {
    for (const id of list.keys()) allIds.add(id);
  }
  for (const id of allIds) {
    let score = 0;
    for (const list of rankLists) {
      const rank = list.get(id);
      if (typeof rank === 'number' && rank > 0) {
        score += 1 / (k + rank);
      }
    }
    out.set(id, score);
  }
  return out;
}
