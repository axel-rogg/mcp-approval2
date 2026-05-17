/**
 * API-Client fuer das Admin-Tab (Multi-User Tier 1, 2026-05-17).
 *
 * Routes: /v1/admin/* (role='admin' enforced server-side via adminOnly).
 * Auth: Bearer via authedFetch (siehe auth-token.ts).
 */
import { authedFetch } from './auth-token.js';

function baseUrl(): string {
  return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8787';
}

// BIGINT-Spalten kommen via postgres-js als string zurueck (precision-safe).
// Wir typisieren ehrlich number|string|null + parsen client-side (fmtDate).
type DbBigInt = number | string | null;

export interface AdminUser {
  readonly id: string;
  readonly email: string;
  readonly display_name: string;
  readonly role: 'admin' | 'member';
  readonly status: 'active' | 'invited' | 'suspended' | 'deleted';
  readonly created_at: DbBigInt;
  readonly last_login_at: DbBigInt;
}

export interface AdminAuditEntry {
  readonly id: string;
  readonly ts: DbBigInt;
  readonly actor_user_id: string | null;
  readonly actor_type: string;
  readonly action: string;
  readonly resource_kind: string | null;
  readonly resource_id: string | null;
  readonly ip: string | null;
  readonly result: string;
}

export interface OutboxEntry {
  readonly id: string;
  readonly toUserId: string | null;
  readonly toEmail: string;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly bodyText: string;
  readonly kind: 'invite' | 'recovery' | 'notification';
  readonly provider: string;
  readonly providerMessageId: string | null;
  readonly status: 'sent' | 'failed' | 'logged';
  readonly errorDetail: string | null;
  readonly createdAt: DbBigInt;
  readonly manuallyDispatchedAt: DbBigInt;
}

export interface CreateInviteResult {
  readonly inviteId: string;
  readonly acceptUrl: string;
  readonly expiresAt: number;
  readonly email: {
    readonly status: 'sent' | 'failed' | 'logged';
    readonly outboxId: string;
    readonly provider: string;
    readonly errorDetail: string | null;
  };
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      detail = parsed.error?.message ?? detail;
    } catch {
      /* keep raw */
    }
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return JSON.parse(text) as T;
}

export interface AdminApi {
  listUsers(args?: { status?: AdminUser['status']; limit?: number }): Promise<AdminUser[]>;
  suspendUser(id: string, reason?: string): Promise<void>;
  unsuspendUser(id: string): Promise<void>;
  changeRole(id: string, role: 'admin' | 'member'): Promise<void>;
  deleteUser(id: string): Promise<void>;
  listAudit(args?: { userId?: string; action?: string; limit?: number }): Promise<AdminAuditEntry[]>;
  createInvite(email: string): Promise<CreateInviteResult>;
  listOutbox(args?: { kind?: OutboxEntry['kind']; status?: OutboxEntry['status']; limit?: number }): Promise<OutboxEntry[]>;
  markDispatched(outboxId: string): Promise<void>;
}

export function createAdminApi(): AdminApi {
  const base = baseUrl();
  return {
    async listUsers(args) {
      const q = new URLSearchParams();
      if (args?.status) q.set('status', args.status);
      if (args?.limit) q.set('limit', String(args.limit));
      const res = await authedFetch(`/v1/admin/users?${q.toString()}`, { method: 'GET' }, base);
      const body = await jsonOrThrow<{ users: AdminUser[] }>(res);
      return body.users;
    },

    async suspendUser(id, reason) {
      const res = await authedFetch(
        `/v1/admin/users/${encodeURIComponent(id)}/suspend`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(reason ? { reason } : {}),
        },
        base,
      );
      await jsonOrThrow(res);
    },

    async unsuspendUser(id) {
      const res = await authedFetch(
        `/v1/admin/users/${encodeURIComponent(id)}/unsuspend`,
        { method: 'POST' },
        base,
      );
      await jsonOrThrow(res);
    },

    async changeRole(id, role) {
      const res = await authedFetch(
        `/v1/admin/users/${encodeURIComponent(id)}/role`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role }),
        },
        base,
      );
      await jsonOrThrow(res);
    },

    async deleteUser(id) {
      const res = await authedFetch(
        `/v1/admin/users/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
        base,
      );
      await jsonOrThrow(res);
    },

    async listAudit(args) {
      const q = new URLSearchParams();
      if (args?.action) q.set('action', args.action);
      if (args?.limit) q.set('limit', String(args.limit));
      const path = args?.userId
        ? `/v1/admin/users/${encodeURIComponent(args.userId)}/audit?${q.toString()}`
        : `/v1/admin/audit?${q.toString()}`;
      const res = await authedFetch(path, { method: 'GET' }, base);
      const body = await jsonOrThrow<{ entries: AdminAuditEntry[] }>(res);
      return body.entries;
    },

    async createInvite(email) {
      const res = await authedFetch(
        '/admin/invites',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email }),
        },
        base,
      );
      return jsonOrThrow<CreateInviteResult>(res);
    },

    async listOutbox(args) {
      const q = new URLSearchParams();
      if (args?.kind) q.set('kind', args.kind);
      if (args?.status) q.set('status', args.status);
      if (args?.limit) q.set('limit', String(args.limit));
      const res = await authedFetch(
        `/v1/admin/email-outbox?${q.toString()}`,
        { method: 'GET' },
        base,
      );
      const body = await jsonOrThrow<{ outbox: OutboxEntry[] }>(res);
      return body.outbox;
    },

    async markDispatched(outboxId) {
      const res = await authedFetch(
        `/v1/admin/email-outbox/${encodeURIComponent(outboxId)}/dispatched`,
        { method: 'POST' },
        base,
      );
      await jsonOrThrow(res);
    },
  };
}
