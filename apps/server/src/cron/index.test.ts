/**
 * Cron-Dispatcher tests.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DbAdapter } from '@mcp-approval2/adapters';
import { CRON_TASKS, isCronTask, runCronTask, UnknownCronTaskError } from './index.js';

function makeDbStub(): DbAdapter {
  const scoped = {
    async query() {
      return [];
    },
    drizzle: {} as unknown,
  };
  return {
    dialect: 'postgres' as const,
    async scoped() {
      return { ...scoped, userId: 'stub', dialect: 'postgres' as const };
    },
    unsafe() {
      return { ...scoped, dialect: 'postgres' as const };
    },
    async transaction<T>(_uid: string, fn: (sc: typeof scoped) => Promise<T>): Promise<T> {
      return fn(scoped);
    },
    async migrate() {},
    async close() {},
  } as unknown as DbAdapter;
}

describe('cron dispatcher', () => {
  it('CRON_TASKS list is complete', () => {
    expect(CRON_TASKS).toContain('auto-archive-apps');
    expect(CRON_TASKS).toContain('purge-trashed-apps');
    expect(CRON_TASKS).toContain('sweep-executing-approvals');
    expect(CRON_TASKS).toContain('sweep-output-refs');
    expect(CRON_TASKS).toContain('sweep-prf-sessions');
    expect(CRON_TASKS).toContain('gateway-discovery');
    expect(CRON_TASKS).toContain('reminders');
  });

  it('isCronTask narrows correctly', () => {
    expect(isCronTask('auto-archive-apps')).toBe(true);
    expect(isCronTask('not-a-task')).toBe(false);
  });

  it('throws UnknownCronTaskError on invalid task', async () => {
    const db = makeDbStub();
    await expect(runCronTask('does-not-exist', { db })).rejects.toBeInstanceOf(
      UnknownCronTaskError,
    );
  });

  it('runs sweep-executing-approvals as noop without approvals service', async () => {
    const db = makeDbStub();
    const result = await runCronTask('sweep-executing-approvals', { db });
    expect(result['swept']).toBe(0);
  });

  it('runs sweep-executing-approvals via service when wired', async () => {
    const db = makeDbStub();
    const sweep = vi.fn(async () => 7);
    const approvals = {
      sweepExpired: sweep,
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
      setResult: vi.fn(),
    } as unknown as Parameters<typeof runCronTask>[1]['approvals'];
    const result = await runCronTask('sweep-executing-approvals', { db, approvals });
    expect(result['swept']).toBe(7);
    expect(sweep).toHaveBeenCalledOnce();
  });

  it('runs sweep-prf-sessions as noop without prf service', async () => {
    const db = makeDbStub();
    const result = await runCronTask('sweep-prf-sessions', { db });
    expect(result['swept']).toBe(0);
  });

  it('runs gateway-discovery as noop without registry', async () => {
    const db = makeDbStub();
    const result = await runCronTask('gateway-discovery', { db });
    expect(result['refreshed']).toBe(0);
  });

  it('runs auto-archive-apps as noop skeleton', async () => {
    const db = makeDbStub();
    const result = await runCronTask('auto-archive-apps', { db });
    expect(result['archived']).toBe(0);
    expect(typeof result['cutoff_ts']).toBe('number');
  });

  it('runs purge-trashed-apps as noop skeleton', async () => {
    const db = makeDbStub();
    const result = await runCronTask('purge-trashed-apps', { db });
    expect(result['purged']).toBe(0);
  });

  it('runs reminders as noop skeleton', async () => {
    const db = makeDbStub();
    const result = await runCronTask('reminders', { db });
    expect(result['fired']).toBe(0);
  });

  it('sweep-output-refs handles missing table gracefully', async () => {
    const db = makeDbStub();
    const result = await runCronTask('sweep-output-refs', { db });
    // Stub returns empty array — counts as 0 swept, not skipped.
    expect(result['swept']).toBe(0);
  });
});
