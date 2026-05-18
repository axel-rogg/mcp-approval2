import { describe, expect, it } from 'vitest';
import type { DbAdapter } from '@mcp-approval2/adapters';
import { runSweepOAuthState } from './sweep-oauth-state.js';
import type { CronDeps } from './index.js';

function makeNoopDb(): DbAdapter {
  return {
    unsafe: () => ({
      async query() {
        return [];
      },
    }),
    scoped: () => {
      throw new Error('scoped not used');
    },
    transaction: () => {
      throw new Error('tx not used');
    },
  } as unknown as DbAdapter;
}

describe('runSweepOAuthState', () => {
  it('skips with no_oauth_service_wired when deps missing', async () => {
    const baseDeps: CronDeps = { db: makeNoopDb() };
    const result = await runSweepOAuthState(baseDeps);
    expect(result.skipped).toBe('no_oauth_service_wired');
  });

  it('calls both cleanup callbacks and returns counts', async () => {
    const calls: string[] = [];
    const deps: CronDeps & {
      sweepOAuthState: {
        cleanupOAuthState: () => Promise<number>;
        cleanupStaleToolCache: (n: number) => Promise<number>;
      };
    } = {
      db: makeNoopDb(),
      now: () => 1_800_000_000_000,
      sweepOAuthState: {
        cleanupOAuthState: async () => {
          calls.push('oauth_state');
          return 3;
        },
        cleanupStaleToolCache: async (staleBefore: number) => {
          calls.push(`tool_cache(${staleBefore})`);
          return 7;
        },
      },
    };
    const result = await runSweepOAuthState(deps);
    expect(result.expired_oauth_states_removed).toBe(3);
    expect(result.stale_tool_cache_entries_removed).toBe(7);
    expect(result.tool_cache_ttl_ms).toBe(30 * 24 * 60 * 60 * 1000);
    expect(calls).toContain('oauth_state');
    // staleBefore = now - 30d
    expect(calls).toContain(`tool_cache(${1_800_000_000_000 - 30 * 24 * 60 * 60 * 1000})`);
  });

  it('fail-soft when cleanup callbacks throw', async () => {
    const deps: CronDeps & {
      sweepOAuthState: {
        cleanupOAuthState: () => Promise<number>;
        cleanupStaleToolCache: (n: number) => Promise<number>;
      };
    } = {
      db: makeNoopDb(),
      sweepOAuthState: {
        cleanupOAuthState: async () => {
          throw new Error('db down');
        },
        cleanupStaleToolCache: async () => {
          throw new Error('blob down');
        },
      },
    };
    const result = await runSweepOAuthState(deps);
    // Beide schlagen fehl → 0/0 zurueck, kein throw
    expect(result.expired_oauth_states_removed).toBe(0);
    expect(result.stale_tool_cache_entries_removed).toBe(0);
  });
});
