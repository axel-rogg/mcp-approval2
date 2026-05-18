/**
 * Cron: sweep-oauth-state — raeumt abgelaufenen OAuth-State der Sub-MCP-
 * Per-User-Authorize-Flows und stale per-User-tool_cache-Eintraege.
 *
 * Plan-Ref: Sprint 2026-05-18 — Per-User-OAuth-Pipeline.
 *
 * Was:
 *   1. user_sub_mcp_oauth_state: Pending-Rows mit `expires_at < now` werden
 *      geloescht (TTL 10 min). Pendant zu v1's `gateway_oauth_pending`-Sweep.
 *      Wenn ein User /oauth/start klickt aber kein /callback eingeht (Tab
 *      geschlossen, Provider-Error), wuerde die Row sonst dauerhaft liegen.
 *
 *   2. user_sub_mcp_tool_cache: Eintraege die laenger als 30 Tage nicht
 *      refreshed wurden (User hat den Server vermutlich nicht mehr aktiv) —
 *      werden geloescht. Discovery wird beim naechsten OAuth-/tools-list-
 *      Call ohnehin neu befuellen.
 */
import type { CronDeps, TaskResult } from './index.js';

export interface OAuthStateSweepDeps {
  readonly cleanupOAuthState: () => Promise<number>;
  readonly cleanupStaleToolCache: (staleBefore: number) => Promise<number>;
}

const TOOL_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 Tage

export async function runSweepOAuthState(
  deps: CronDeps & { sweepOAuthState?: OAuthStateSweepDeps },
): Promise<TaskResult> {
  const now = deps.now ?? (() => Date.now());
  const s = deps.sweepOAuthState;
  if (!s) {
    return { skipped: 'no_oauth_service_wired' };
  }
  const staleBefore = now() - TOOL_CACHE_TTL_MS;
  const [stateRemoved, cacheRemoved] = await Promise.all([
    s.cleanupOAuthState().catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.warn(
        `[sweep-oauth-state] cleanupOAuthState failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }),
    s.cleanupStaleToolCache(staleBefore).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.warn(
        `[sweep-oauth-state] cleanupStaleToolCache failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }),
  ]);
  return {
    expired_oauth_states_removed: stateRemoved,
    stale_tool_cache_entries_removed: cacheRemoved,
    tool_cache_ttl_ms: TOOL_CACHE_TTL_MS,
  };
}
