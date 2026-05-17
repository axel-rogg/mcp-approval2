/**
 * UserSyncService — Push approval2-User-State an KC2.
 *
 * Plan-Ref: PLAN-as3-autonomous.md §2.2 + A11.
 *
 * Wird aufgerufen bei:
 *   - User-Create (auth/bootstrap.ts, auth/invite/accept.ts)
 *   - User-Suspend / Activate (services/admin.ts)
 *   - User-Erase (services/gdpr.ts)
 *
 * Pattern: Fire-and-forget mit Audit-on-Failure. Wir wollen KC2-Outage
 * NICHT die approval2-User-State-Aenderung blockieren (approval2 ist
 * Source-of-Truth, KC2 nachzieht). Bei Failure:
 *   - audit-Event mit `result: 'failure'` + error-message
 *   - Folge-Refresh-Cron (A9 oder ein separater user-sync-replay-cron,
 *     Phase 2) holt das auf.
 *
 * Phase 1: kein Retry, kein Replay-Queue.
 */
import type { KnowledgeAdapter, SyncUserArgs, UserSyncStatus } from '@mcp-approval2/adapters';
import { emitAudit, type AuditEvent } from './audit.js';
import type { DbAdapter } from '@mcp-approval2/adapters';

export interface UserSyncDeps {
  readonly adapter: KnowledgeAdapter;
  readonly db: DbAdapter;
}

export interface UserSyncService {
  /**
   * Push user state an KC2. Bei Failure: audit + swallow (kein throw).
   * Returns `true` wenn erfolgreich, `false` sonst.
   */
  push(args: SyncUserArgs): Promise<boolean>;
}

export function createUserSyncService(deps: UserSyncDeps): UserSyncService {
  return {
    async push(args: SyncUserArgs): Promise<boolean> {
      try {
        const result = await deps.adapter.syncUser(args);
        await emitAudit(deps.db, makeAudit('success', args, result.status));
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await emitAudit(deps.db, makeAudit('failure', args, undefined, message));
        return false;
      }
    },
  };
}

function makeAudit(
  result: 'success' | 'failure',
  args: SyncUserArgs,
  upstreamStatus?: 'created' | 'updated' | 'unchanged',
  error?: string,
): AuditEvent {
  const details: Record<string, unknown> = {
    target_user_id: args.userId,
    email: args.email,
    status: args.status,
  };
  if (upstreamStatus !== undefined) details['upstream_status'] = upstreamStatus;
  if (error !== undefined) details['error'] = error;
  return {
    action: 'user.sync_to_kc2',
    actorUserId: null, // System-Call, kein User-Initiator
    result,
    details,
  };
}

/**
 * Convenience: Build SyncUserArgs aus einer users-Row.
 */
export function syncArgsFromUser(user: {
  id: string;
  email: string;
  displayName: string;
  status: UserSyncStatus;
  externalId: string | null;
}): SyncUserArgs {
  const out: {
    userId: string;
    email: string;
    displayName: string;
    status: UserSyncStatus;
    externalId?: string;
  } = {
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
  };
  if (user.externalId) out.externalId = user.externalId;
  return out;
}
