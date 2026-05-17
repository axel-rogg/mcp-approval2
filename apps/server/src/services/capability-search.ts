/**
 * CapabilitySearchService — RRF-Fusion zwischen Tool-Suche und Skill-Suche.
 *
 * Plan-Ref: PLAN-architecture-v1.md §7 (Tool-Surface). Portiert von
 * mcp-approval/src/tools/capability_search.ts (Production-Scale 500 Tools +
 * 80 Skills).
 *
 * Algorithmus:
 *   1. Parallel-Fanout: Tool-Suche (lexikalisch ueber registry-metadata) +
 *      Skill-Suche (via KnowledgeService.search(subtypes=['skill_manifest'])).
 *   2. Rank-Listen pro Surface bauen — 1-basierte Position = Rank.
 *   3. RRF-Fusion (k=60, Cormack et al. 2009): cross-source-comparable
 *      Score = sum(1 / (k + rank_in_list_i)).
 *   4. Per-Kind-Quota anwenden (8 Tools + 5 Skills default), final mergen.
 *
 * IPI-Boundary: Tools+Skills sind System-trusted (Registry-Metadaten,
 * Manifest), keine Fence. `search` (User-Content-Federated) ist eine
 * andere Surface.
 */
import type { AnyTool } from '../mcp/protocol/tool.js';
import type { KnowledgeService } from './knowledge.js';
import type { ToolRegistry } from '../mcp/protocol/registry.js';
import { scoreRRF } from '../lib/scorers.js';

const DEFAULT_TOOL_QUOTA = 8;
const DEFAULT_SKILL_QUOTA = 5;
const RRF_K = 60;

export interface ToolMatch {
  readonly id: string;
  readonly handle: string;
  readonly description: string;
  readonly sensitivity: 'read' | 'write' | 'danger';
  readonly source_score: number;
  readonly fused_score: number;
}

export interface SkillMatch {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly source_score: number;
  readonly fused_score: number;
}

export interface CapabilitySearchArgs {
  readonly userId: string;
  readonly query: string;
  readonly toolQuota?: number;
  readonly skillQuota?: number;
}

export interface CapabilitySearchResult {
  readonly tools: ReadonlyArray<ToolMatch>;
  readonly skills: ReadonlyArray<SkillMatch>;
  readonly alt?: ReadonlyArray<string>;
}

export interface CapabilitySearchService {
  search(args: CapabilitySearchArgs): Promise<CapabilitySearchResult>;
}

export interface CapabilitySearchServiceOptions {
  readonly toolRegistry: ToolRegistry;
  readonly knowledge: KnowledgeService;
}

// ---------------------------------------------------------------------------
// Local lexical scorer over tool registry metadata.
//
// Production-grade implementations swap this for a real BM25/TF-IDF index;
// for now we do a simple substring-matched score with token-overlap weighting.
// Score ranges 0..1.
// ---------------------------------------------------------------------------

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function scoreToolMatch(query: string, tool: AnyTool): number {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return 0;
  const haystack = tokenize(`${tool.name} ${tool.description}`);
  if (haystack.length === 0) return 0;
  const hayset = new Set(haystack);
  let hits = 0;
  for (const t of qTokens) {
    if (t.length < 3) continue; // skip stop-words / short tokens
    if (hayset.has(t)) hits += 1;
  }
  return Math.min(1, hits / qTokens.length);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCapabilitySearchService(
  opts: CapabilitySearchServiceOptions,
): CapabilitySearchService {
  const { toolRegistry, knowledge } = opts;

  return {
    async search(args): Promise<CapabilitySearchResult> {
      const toolQuota = args.toolQuota ?? DEFAULT_TOOL_QUOTA;
      const skillQuota = args.skillQuota ?? DEFAULT_SKILL_QUOTA;
      const probeLimit = Math.max(toolQuota * 2, skillQuota * 2, 20);

      // ── Tool-Surface ────────────────────────────────────────────────
      const allTools = toolRegistry.list();
      const toolScored: Array<{ tool: AnyTool; meta: ReturnType<ToolRegistry['list']>[number]; score: number }> = [];
      for (const meta of allTools) {
        const tool = toolRegistry.get(meta.name);
        if (!tool) continue;
        const score = scoreToolMatch(args.query, tool);
        if (score > 0) toolScored.push({ tool, meta, score });
      }
      toolScored.sort((a, b) => b.score - a.score);
      const toolsTop = toolScored.slice(0, probeLimit);

      // ── Skill-Surface ───────────────────────────────────────────────
      let skillsTop: ReadonlyArray<{ id: string; title: string | null; description: string | null; score: number }> = [];
      try {
        const hits = await knowledge.search({
          userId: args.userId,
          query: args.query,
          subtypes: ['skill_manifest'],
          limit: probeLimit,
        });
        skillsTop = hits.map((h) => ({
          id: h.id,
          title: h.title,
          description: null,
          score: h.score,
        }));
      } catch {
        // Soft-fail: knowledge backend unavailable.
        skillsTop = [];
      }

      // ── RRF-Fusion ───────────────────────────────────────────────────
      const toolRanks = new Map<string, number>();
      const skillRanks = new Map<string, number>();
      toolsTop.forEach((h, i) => toolRanks.set(`tool:${h.tool.name}`, i + 1));
      skillsTop.forEach((h, i) => skillRanks.set(`skill:${h.id}`, i + 1));

      const fused = scoreRRF([toolRanks, skillRanks], RRF_K);

      // ── Hydrate + Quota ─────────────────────────────────────────────
      const tools: ToolMatch[] = toolsTop.map((h) => ({
        id: h.tool.name,
        handle: h.tool.name,
        description: h.tool.description,
        sensitivity: h.tool.sensitivity,
        source_score: Number(h.score.toFixed(6)),
        fused_score: Number((fused.get(`tool:${h.tool.name}`) ?? 0).toFixed(6)),
      }));
      const skills: SkillMatch[] = skillsTop.map((h) => ({
        id: h.id,
        title: h.title ?? '(untitled)',
        description: h.description,
        source_score: Number(h.score.toFixed(6)),
        fused_score: Number((fused.get(`skill:${h.id}`) ?? 0).toFixed(6)),
      }));

      tools.sort((a, b) => b.fused_score - a.fused_score);
      skills.sort((a, b) => b.fused_score - a.fused_score);

      const out: CapabilitySearchResult = {
        tools: tools.slice(0, toolQuota),
        skills: skills.slice(0, skillQuota),
      };

      // Cross-promotion hint
      if (tools.length > toolQuota || skills.length > skillQuota) {
        return {
          ...out,
          alt: ['re-run with higher toolQuota / skillQuota for the long tail'],
        };
      }
      return out;
    },
  };
}
