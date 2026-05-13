/**
 * Cost-Gate-Middleware — pre-AI-Call Budget-Check.
 *
 * Plan-Ref: PLAN-architecture-v1.md §10 (Cost-Controls), §8.3.
 *
 * Verwendung: WRAPPING um AI-Tool-Dispatch ODER /mcp-Route, abhaengig von der
 * Granularitaet. In Phase 1 wrappen wir es per-Route (z.B.
 * `app.post('/mcp/...', costGate, mcpHandler)`).
 *
 * Pre-Check-Strategie:
 *   - Static Estimate (default 0.001 USD) per AI-Call. Mehr Tools, mehr Calls
 *     → Estimate kann angepasst werden.
 *   - Sub-Route- oder Tool-Override via `estimator(c)`-Funktion.
 *
 * Wenn precheck() allowed=false → throw HttpError(429, 'rate_limited', ...) mit
 * details.scope = 'cost'. Caller error-handler-Middleware mapped das auf JSON.
 *
 * Soft-Limit: Header X-Cost-Soft-Limit: true. Caller-Tool kann darauf
 * reagieren (z.B. UI-Warning, weniger aggressives Caching).
 *
 * Unauthenticated requests: skip (sind keine User-Costs).
 */
import type { Context, MiddlewareHandler, Next } from 'hono';
import type { AppBindings } from '../lib/context.js';
import { HttpError } from '../lib/errors.js';
import type { CostTracker } from '../services/cost-tracker.js';

export interface CostGateDeps {
  readonly tracker: CostTracker;
  /**
   * Optional: pro-Request-Estimator. Default ist eine Konstante
   * (`defaultEstimateUsd`), falls Caller den Estimate genauer kennt (z.B.
   * input-token-count des Request-Bodys), wird der hier injected.
   *
   * Wenn der Estimator 0 zurueck gibt, wird precheck() ueberspruengen (Request
   * gilt als "kein AI-Call").
   */
  readonly estimator?: (c: Context<AppBindings>) => Promise<number> | number;
  /** Default-Estimate falls kein Estimator gesetzt. Default 0.001 USD. */
  readonly defaultEstimateUsd?: number;
  /** Override-Hard-Limit fuer Display-Zwecke (nicht zum gating; das macht tracker). Optional. */
  readonly displayLimitUsd?: number;
}

const DEFAULT_ESTIMATE_USD = 0.001;

export function createCostGate(deps: CostGateDeps): MiddlewareHandler<AppBindings> {
  const estimator = deps.estimator ?? ((): number => deps.defaultEstimateUsd ?? DEFAULT_ESTIMATE_USD);

  return async (c: Context<AppBindings>, next: Next): Promise<void> => {
    const user = c.get('user');
    if (!user) {
      // Unauthenticated routes are not subject to per-user cost-gating.
      await next();
      return;
    }

    const estimate = await estimator(c);
    if (!estimate || estimate <= 0) {
      // Caller signaliziert: kein AI-Call. Skip precheck/record.
      await next();
      return;
    }

    const check = await deps.tracker.precheck({
      userId: user.userId,
      estimatedUsd: estimate,
    });

    if (!check.allowed) {
      c.header('X-Cost-Spent-USD', String(check.spentUsd.toFixed(6)));
      c.header('X-Cost-Limit-USD', String(check.limitUsd.toFixed(2)));
      throw new HttpError(429, 'rate_limited', 'cost_limit_exceeded', {
        scope: 'cost',
        spentUsd: check.spentUsd,
        limitUsd: check.limitUsd,
        reason: check.reason ?? 'daily_limit_exhausted',
      });
    }

    // Observability-Header.
    c.header('X-Cost-Spent-USD', String(check.spentUsd.toFixed(6)));
    c.header('X-Cost-Remaining-USD', String(check.remainingUsd.toFixed(6)));
    if (check.softLimitReached) {
      c.header('X-Cost-Soft-Limit', 'true');
    }

    await next();
  };
}
