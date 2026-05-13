/**
 * CostTracker — Per-User Tages-USD-Budget fuer AI-Inference.
 *
 * Plan-Ref: PLAN-architecture-v1.md §10 (Cost-Controls), §8.3.
 *
 * Pipeline:
 *   1. Pre-Call: `precheck({ userId, estimatedUsd })` — Tageskosten + Estimate
 *      vs Limit. Returns allowed + remainingUsd.
 *      Soft-Limit (80%) → Warning-Header optional vom Caller setzen.
 *      Hard-Limit (100%) → allowed=false, Caller wirft 429.
 *   2. AI-Call laeuft (Adapter macht den Vertex-Call).
 *   3. Post-Call: `record({ userId, provider, model, tokens, totalUsd, ... })`.
 *      INSERT in cost_ledger. Aggregation passiert via View / Query in precheck().
 *
 * Pricing-Tabelle: hardcoded in `PRICING` Map unten. Stand 2026-Q2.
 * TODO Phase 6: dynamic pricing from Vertex billing API, not hardcoded.
 *
 * Token-Counting: Caller liefert die Token-Counts (kommt aus
 * VertexGenerateContentResponse.usageMetadata). Bei Embeddings: tokenCount
 * aus `embeddings.statistics.token_count` summieren.
 *
 * estimateUsd-Helpers: `estimateChat()` und `estimateEmbed()` fuer das Pre-
 * check-Estimate. Wir overestimieren leicht (5% Puffer) damit der echte Call
 * nicht ueber-budget rauskommt.
 *
 * Single-User-Pattern: kein admin-override fuer precheck() — wenn Admin
 * einen User-Token nutzt, faellt das auch in dessen Budget. Pro Phase 1 ok.
 */
import type { DbAdapter } from '@mcp-approval2/adapters';
import type { CostProvider } from '../schema/types.js';

export interface CostTrackerDeps {
  readonly db: DbAdapter;
  /** Tageslimit USD pro User. Default 5.00. Override via Config/env. */
  readonly dailyLimitUsd?: number;
  /** Soft-Limit-Schwelle als Fraction (0..1). Default 0.8 (80%). */
  readonly softLimitFraction?: number;
  /** Clock fuer Tests. Default Date.now(). */
  readonly now?: () => number;
}

export interface PrecheckArgs {
  readonly userId: string;
  /** Geschaetzte USD-Kosten des bevorstehenden Calls. */
  readonly estimatedUsd: number;
}

export interface PrecheckResult {
  readonly allowed: boolean;
  /** Verbleibendes USD-Budget nach Estimate-Abzug (kann negativ werden wenn !allowed). */
  readonly remainingUsd: number;
  /** Bereits verbrauchte USD heute (ohne Estimate). */
  readonly spentUsd: number;
  /** Hard-Limit USD. */
  readonly limitUsd: number;
  /** true wenn Estimate ueber Soft-Limit. */
  readonly softLimitReached: boolean;
  /** Reason wenn !allowed. */
  readonly reason?: 'daily_limit_exhausted';
}

export interface RecordArgs {
  readonly userId: string;
  readonly provider: CostProvider;
  readonly model: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly embeddingTokens?: number;
  readonly totalUsd: number;
  readonly requestId?: string;
}

export interface DailyArgs {
  readonly userId: string;
  /** YYYY-MM-DD UTC. Default heute. */
  readonly date?: string;
}

export interface DailyResult {
  readonly date: string;
  readonly totalUsd: number;
  readonly calls: number;
}

export interface CostTracker {
  precheck(args: PrecheckArgs): Promise<PrecheckResult>;
  record(args: RecordArgs): Promise<void>;
  getDaily(args: DailyArgs): Promise<DailyResult>;
  /** Inline-Helper fuer Cost-Estimation. */
  estimateChat(args: {
    model: string;
    promptTokens: number;
    completionTokens: number;
  }): number;
  estimateEmbed(args: { model: string; tokens: number }): number;
}

const DEFAULT_DAILY_LIMIT_USD = 5.0;
const DEFAULT_SOFT_LIMIT_FRACTION = 0.8;

/**
 * Pricing-Tabelle (USD pro Token — wir rechnen pro-Token, nicht pro-1k-Token,
 * damit das Estimate-Math konsistent bleibt). Stand 2026-Q2.
 *
 * TODO Phase 6: dynamic pricing from Vertex billing API, not hardcoded.
 */
interface ModelPricing {
  /** USD pro Input-Token (Prompt / Embed-Input). */
  readonly input: number;
  /** USD pro Output-Token. Undefined fuer Embed-Models. */
  readonly output?: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Embed: $0.025 / 1M tokens = 2.5e-8 / token
  'text-embedding-005': { input: 0.025 / 1_000_000 },
  // Chat: gemini-2.0-flash-exp — $0.10/M in, $0.40/M out (2026-Q2 ballpark)
  'gemini-2.0-flash-exp': {
    input: 0.10 / 1_000_000,
    output: 0.40 / 1_000_000,
  },
  // Chat: gemini-2.5-pro — $1.25/M in, $5.00/M out
  'gemini-2.5-pro': {
    input: 1.25 / 1_000_000,
    output: 5.0 / 1_000_000,
  },
};

/** Fallback wenn Model nicht in PRICING — konservativ schaetzen damit precheck nicht 0 zurueck gibt. */
const FALLBACK_INPUT_USD_PER_TOKEN = 1.0 / 1_000_000;
const FALLBACK_OUTPUT_USD_PER_TOKEN = 4.0 / 1_000_000;
/** 5% Puffer-Aufschlag damit echter Call nicht ueber-budget kommt. */
const ESTIMATE_OVERHEAD_FACTOR = 1.05;

export function createCostTracker(deps: CostTrackerDeps): CostTracker {
  const limitUsd = deps.dailyLimitUsd ?? DEFAULT_DAILY_LIMIT_USD;
  const softFraction = deps.softLimitFraction ?? DEFAULT_SOFT_LIMIT_FRACTION;
  const now = deps.now ?? ((): number => Date.now());

  function todayUtc(): string {
    return new Date(now()).toISOString().slice(0, 10);
  }

  async function spentToday(userId: string, date: string): Promise<{
    totalUsd: number;
    calls: number;
  }> {
    const raw = deps.db.unsafe('cost_tracker:precheck');
    const rows = await raw.query<{ total_usd: string | number | null; calls: string | number | null }>(
      `SELECT
         COALESCE(SUM(total_usd), 0)  AS total_usd,
         COALESCE(SUM(call_count), 0) AS calls
       FROM cost_ledger
       WHERE user_id = $1 AND date = $2`,
      [userId, date],
    );
    const row = rows[0];
    return {
      totalUsd: row ? Number(row.total_usd ?? 0) : 0,
      calls: row ? Number(row.calls ?? 0) : 0,
    };
  }

  return {
    estimateChat({ model, promptTokens, completionTokens }): number {
      const p = PRICING[model];
      const inPerTok = p?.input ?? FALLBACK_INPUT_USD_PER_TOKEN;
      const outPerTok = p?.output ?? FALLBACK_OUTPUT_USD_PER_TOKEN;
      const raw = promptTokens * inPerTok + completionTokens * outPerTok;
      return raw * ESTIMATE_OVERHEAD_FACTOR;
    },

    estimateEmbed({ model, tokens }): number {
      const p = PRICING[model];
      const inPerTok = p?.input ?? FALLBACK_INPUT_USD_PER_TOKEN;
      return tokens * inPerTok * ESTIMATE_OVERHEAD_FACTOR;
    },

    async precheck(args): Promise<PrecheckResult> {
      const date = todayUtc();
      const { totalUsd: spent } = await spentToday(args.userId, date);
      const projected = spent + args.estimatedUsd;
      const remaining = limitUsd - projected;
      const allowed = projected <= limitUsd;
      const softLimitReached = projected >= limitUsd * softFraction;
      const result: PrecheckResult = {
        allowed,
        remainingUsd: remaining,
        spentUsd: spent,
        limitUsd,
        softLimitReached,
        ...(allowed ? {} : { reason: 'daily_limit_exhausted' as const }),
      };
      return result;
    },

    async record(args): Promise<void> {
      const date = todayUtc();
      const raw = deps.db.unsafe('cost_tracker:record');
      await raw.query(
        `INSERT INTO cost_ledger
           (user_id, date, provider, model, prompt_tokens, completion_tokens,
            embedding_tokens, total_usd, call_count, request_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10)`,
        [
          args.userId,
          date,
          args.provider,
          args.model,
          args.promptTokens ?? 0,
          args.completionTokens ?? 0,
          args.embeddingTokens ?? 0,
          args.totalUsd,
          args.requestId ?? null,
          now(),
        ],
      );
    },

    async getDaily(args): Promise<DailyResult> {
      const date = args.date ?? todayUtc();
      const r = await spentToday(args.userId, date);
      return { date, totalUsd: r.totalUsd, calls: r.calls };
    },
  };
}
