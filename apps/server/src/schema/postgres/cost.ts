/**
 * cost_ledger — Per-User Tagessummen fuer AI-Inference-Kosten.
 *
 * Plan-Ref: PLAN-architecture-v1.md §10 (Rate-Limiting + Cost-Controls), §8.3
 * (AI-Provider Cost-Control).
 *
 * Design:
 *   - Pro `record()`-Call ein neuer Row (kein UPSERT). Aggregation per
 *     `getDaily()` aggregiert ueber (user_id, date).
 *   - `date` ist eine PG-DATE-Spalte (YYYY-MM-DD) — Index-Lookup pro Tages-
 *     Bucket. Date wird UTC im Service berechnet damit der Schalt-Zeitpunkt
 *     deterministisch ist.
 *   - `total_usd` ist DOUBLE PRECISION fuer fractional Cent-Beträge (z.B.
 *     $0.0000125 fuer ein 1k-Token-Embedding).
 *   - `call_count` ist 1 fuer einen einzelnen Call, kann aber > 1 sein wenn
 *     ein Caller batched recordet (selten — derzeit nicht genutzt).
 *
 * Indexe:
 *   - (user_id, date): Hot-Path fuer precheck() / getDaily().
 *   - created_at: optional fuer Time-Range-Queries (Reports).
 *
 * Aggregations-View `cost_daily`: vorberechnete SUM-Aggregation. Hilfreich bei
 * vielen Rows pro User pro Tag.
 *
 * RLS: keine. Cost-Records sind System-Bookkeeping. Reads gehen ueber den
 * Cost-Tracker-Service mit explizitem userId-Filter; raw-Reads sind admin-only.
 */
import { bigint, date, doublePrecision, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const costLedgerTable = pgTable(
  'cost_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    /** YYYY-MM-DD UTC — Tages-Bucket. */
    date: date('date').notNull(),
    /** 'vertex' fuer Phase 1; Erweiterung in Phase 4+ (OpenAI etc.). */
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    embeddingTokens: integer('embedding_tokens').notNull().default(0),
    totalUsd: doublePrecision('total_usd').notNull(),
    callCount: integer('call_count').notNull().default(1),
    requestId: uuid('request_id'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    userDateIdx: index('idx_cost_ledger_user_date').on(t.userId, t.date),
    createdAtIdx: index('idx_cost_ledger_created').on(t.createdAt),
  }),
);
