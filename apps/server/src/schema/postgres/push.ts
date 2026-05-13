/**
 * push_subscriptions — WebPush-Subscriptions pro User.
 *
 * Plan-Ref: PLAN-architecture-v1.md §7 (Notification-Surface). Portiert von
 * mcp-approval/src/push/* (Workers/WebCrypto-Variante; Node-Variante hier nutzt
 * `web-push`).
 *
 * Lifecycle:
 *   - subscribe()   — INSERT mit endpoint UNIQUE-constraint. Re-subscribe via
 *                     ON CONFLICT(endpoint) DO UPDATE (vom Service-Layer).
 *   - unsubscribe() — DELETE by id (owner-only via RLS).
 *   - send()        — POST encrypted body an endpoint; bei 410 (Gone) row
 *                     opportunistic geloescht.
 *
 * RLS: owner-only — `user_id = current_setting('app.current_user', true)::uuid`.
 * Indexes: (user_id) fuer list-by-user; UNIQUE(endpoint) — der Push-Service
 *   gibt jedem Browser/Geraet eine eindeutige URL.
 *
 * Felder:
 *   - `p256dh` / `auth`: base64url-encoded WebCrypto-Keys aus dem Browser-
 *     `PushSubscription.toJSON()` (NACOTtcompressed P-256 point bzw. 16-byte
 *     auth-secret).
 *   - `user_agent`: optional, fuer "letzte Subscription stammt aus Firefox-
 *     Desktop"-Anzeige in Settings.
 *   - `last_used_at`: gesetzt nach erfolgreichem send() — hilft beim Aufspueren
 *     stale Subscriptions.
 */
import {
  bigint,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const pushSubscriptionsTable = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastUsedAt: bigint('last_used_at', { mode: 'number' }),
  },
  (t) => ({
    endpointUnique: uniqueIndex('idx_push_subscriptions_endpoint').on(t.endpoint),
    userIdx: index('idx_push_subscriptions_user').on(t.userId),
  }),
);

export interface PushSubscriptionRow {
  readonly id: string;
  readonly userId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly userAgent: string | null;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
}
