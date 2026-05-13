/**
 * rate_limit_buckets + gdpr_erase_queue — Drizzle-Schema.
 *
 * Plan-Ref: PLAN-architecture-v1.md §10 (Rate-Limiting), §5.5 (Crypto-Shred),
 *           §11.2 (Offboarding).
 *
 * rate_limit_buckets:
 *   bucket_id-Konvention:
 *     - 'user:<uuid>'    — pro-User-Request-Counter
 *     - 'tenant:global'  — instance-weiter Bucket (Anti-Burst)
 *     - 'cost:<uuid>'    — Tages-USD-Budget pro User (Phase 6, Schema-ready)
 *
 *   tokens / last_refill: aktueller State des Token-Buckets (lazy-refill-Modell).
 *   capacity / refill_per_sec: config-Snapshot pro Row. In-Memory-Bucket ist
 *   Source-of-Truth; DB ist persistenter Fallback fuer Cost-Counter und Phase-2
 *   Multi-Instance-Plan (dann Redis statt DB).
 *
 * gdpr_erase_queue:
 *   User triggert `DELETE /v1/gdpr/erase` → soft-delete + Queue-Row. Cron
 *   pruft `purge_after_at <= now` + triggert Hard-Delete (Crypto-Shred +
 *   Cascade an mcp-knowledge2). 30-Tage-Grace-Period default.
 */
import { bigint, doublePrecision, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const rateLimitBucketsTable = pgTable(
  'rate_limit_buckets',
  {
    bucketId: text('bucket_id').primaryKey(),
    tokens: doublePrecision('tokens').notNull(),
    lastRefill: bigint('last_refill', { mode: 'number' }).notNull(),
    capacity: doublePrecision('capacity').notNull(),
    refillPerSec: doublePrecision('refill_per_sec').notNull(),
  },
  (t) => ({
    lastRefillIdx: index('idx_rate_limit_buckets_last_refill').on(t.lastRefill),
  }),
);

export const gdprEraseQueueTable = pgTable(
  'gdpr_erase_queue',
  {
    userId: uuid('user_id').primaryKey(),
    requestedAt: bigint('requested_at', { mode: 'number' }).notNull(),
    purgeAfterAt: bigint('purge_after_at', { mode: 'number' }).notNull(),
    requestedBy: uuid('requested_by'),
    status: text('status').notNull().default('pending'),
    processedAt: bigint('processed_at', { mode: 'number' }),
    failureReason: text('failure_reason'),
  },
  (t) => ({
    purgeAfterIdx: index('idx_gdpr_erase_purge_after').on(t.purgeAfterAt),
    statusIdx: index('idx_gdpr_erase_status').on(t.status),
  }),
);
