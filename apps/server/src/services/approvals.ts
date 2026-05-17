/**
 * ApprovalService — verwaltet pending_approvals fuer State-modifying Tool-Calls.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2 (Request-Lifecycle Step 5), §11 Phase 4.
 *
 * Lifecycle:
 *   create() → status='pending', expires_at = now + ttl. Tool-Input + rendered
 *     display-string werden persistiert. Caller-Transport returnt
 *     `approval_id` an MCP-Client.
 *   approve() → WebAuthn-Signature wird persistiert (Phase-4-Variante:
 *     opaque-bytes-store; echte Assertion-Verifikation kommt aus
 *     `@simplewebauthn/server` und ist hier injection-point). status='approved'.
 *     Re-Dispatch + setResult sind Caller-Pflicht (siehe approval-resume.ts).
 *   reject() → status='rejected'.
 *   sweepExpired() (cron) → flippt pending → expired wenn expires_at < now.
 *
 * Idempotency: zweimal approve auf eine schon-approved Row → ConflictError (409).
 *
 * RLS: Service-Calls laufen ueber `db.scoped(userId)` → SET LOCAL app.current_user.
 *   user_id im WHERE redundant, aber Defense-in-Depth.
 *
 * Display-Template-Rendering:
 *   Mustache-style `{{path.to.field}}` aus tool_input. Sicherheits-Garantien:
 *     - NUR aus toolInput-Object rendern (kein eval, kein this/global).
 *     - HTML-Tags strippen (Anti-XSS in PWA).
 *     - Max 500 Zeichen Output.
 *     - Unbekannte Pfade rendern als '?'.
 */
import type { DbAdapter } from '@mcp-approval2/adapters';
import { randomBytes } from '@mcp-approval2/core';
import { AppError, HttpError } from '../lib/errors.js';
import { emitAudit } from './audit.js';
import type {
  ApprovalSensitivity,
  ApprovalStatus,
  PendingApproval,
} from '../schema/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CreateApprovalArgs {
  readonly userId: string;
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly displayTemplate?: string;
  readonly sensitivity: ApprovalSensitivity;
  readonly requestId?: string;
  readonly ip?: string;
  /** TTL in Sekunden. Default: 300 (5 min). */
  readonly ttlSec?: number;
}

export interface GetApprovalArgs {
  readonly id: string;
  readonly userId: string;
}

export interface ListApprovalsArgs {
  readonly userId: string;
  readonly status?: ApprovalStatus;
  /** 1..200, default 50. */
  readonly limit?: number;
}

export interface ApproveArgs {
  readonly id: string;
  readonly userId: string;
  readonly signature: Uint8Array;
  readonly prfSessionId?: string;
}

export interface RejectArgs {
  readonly id: string;
  readonly userId: string;
  readonly reason?: string;
}

export interface SetResultArgs {
  readonly id: string;
  readonly result: Record<string, unknown>;
}

export interface ApprovalService {
  create(args: CreateApprovalArgs): Promise<PendingApproval>;
  get(args: GetApprovalArgs): Promise<PendingApproval | null>;
  list(args: ListApprovalsArgs): Promise<PendingApproval[]>;
  approve(args: ApproveArgs): Promise<PendingApproval>;
  reject(args: RejectArgs): Promise<PendingApproval>;
  sweepExpired(): Promise<number>;
  setResult(args: SetResultArgs): Promise<void>;
}

/**
 * Sentinel: Approval ist nicht (mehr) im pending-Status. Caller mappt auf 409.
 * `currentStatus` ist 'approved' | 'rejected' | 'expired' wenn bekannt, sonst
 * 'unknown' (CAS-Race).
 */
export type ApprovalConflictStatus = ApprovalStatus | 'unknown';

export class ApprovalConflictError extends AppError {
  public readonly approvalId: string;
  public readonly currentStatus: ApprovalConflictStatus;
  constructor(approvalId: string, currentStatus: ApprovalConflictStatus) {
    super('conflict', `approval ${approvalId} not pending (status=${currentStatus})`, {
      approvalId,
      currentStatus,
    });
    this.name = 'ApprovalConflictError';
    this.approvalId = approvalId;
    this.currentStatus = currentStatus;
  }
}

// ---------------------------------------------------------------------------
// Internal row-shape (raw DB)
// ---------------------------------------------------------------------------

interface ApprovalRowRaw {
  readonly id: string;
  readonly user_id: string;
  readonly tool_name: string;
  readonly tool_input: Record<string, unknown>;
  readonly display_template: string | null;
  readonly display_rendered: string | null;
  readonly sensitivity: string;
  readonly status: string;
  readonly approval_challenge: string | null;
  readonly approval_signature: Uint8Array | null;
  readonly approved_at: number | string | null;
  readonly rejected_at: number | string | null;
  readonly rejection_reason: string | null;
  readonly expired_at: number | string | null;
  readonly prf_session_id: string | null;
  readonly result_json: Record<string, unknown> | null;
  readonly result_emitted_at: number | string | null;
  readonly request_id: string | null;
  readonly origin_ip: string | null;
  readonly created_at: number | string;
  readonly expires_at: number | string;
}

const SELECT_COLS = `
  id, user_id, tool_name, tool_input,
  display_template, display_rendered,
  sensitivity, status,
  approval_challenge, approval_signature,
  approved_at, rejected_at, rejection_reason, expired_at,
  prf_session_id,
  result_json, result_emitted_at,
  request_id, origin_ip,
  created_at, expires_at
`;

function toNumber(v: number | string | null): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'number' ? v : Number(v);
}

function rowToApproval(row: ApprovalRowRaw): PendingApproval {
  return {
    id: row.id,
    userId: row.user_id,
    toolName: row.tool_name,
    toolInput: row.tool_input,
    displayTemplate: row.display_template,
    displayRendered: row.display_rendered,
    sensitivity: row.sensitivity,
    status: row.status,
    approvalChallenge: row.approval_challenge,
    approvalSignature: row.approval_signature,
    approvedAt: toNumber(row.approved_at),
    rejectedAt: toNumber(row.rejected_at),
    rejectionReason: row.rejection_reason,
    expiredAt: toNumber(row.expired_at),
    prfSessionId: row.prf_session_id,
    resultJson: row.result_json,
    resultEmittedAt: toNumber(row.result_emitted_at),
    requestId: row.request_id,
    originIp: row.origin_ip,
    createdAt: toNumber(row.created_at) ?? 0,
    expiresAt: toNumber(row.expires_at) ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Display-Template Renderer (sicherheits-bewusst)
// ---------------------------------------------------------------------------

// SEC-020: erweiterte Syntax — `{{path|preview:N}}` rendert die ersten N
// Zeichen des resolved Werts mit Ellipsis bei truncation. Damit koennen
// write/danger-Tools ein Preview des Body-Content im signed Display zeigen,
// ohne dass die ganze multi-KB-Payload den Approval-Card sprengt.
//   {{title}}           — full resolve, MAX_RENDERED_LEN clamp gilt
//   {{body|preview:80}} — first 80 chars + …
//   {{xs.length}}       — array-length (unveraendert)
const TEMPLATE_RE = /\{\{\s*([a-zA-Z0-9_.[\]-]+)(?:\s*\|\s*preview\s*:\s*(\d+))?\s*\}\}/g;
const HTML_TAG_RE = /<[^>]*>/g;
const MAX_RENDERED_LEN = 500;

/**
 * Mustache-style Path-Lookup auf einem JSON-Objekt. Unterstuetzt:
 *   - `field`         → obj.field
 *   - `a.b.c`         → obj.a.b.c
 *   - `arr.length`    → falls obj.arr ein Array oder String ist
 *
 * KEINE eval, KEIN this-Access. Unbekannte Pfade → undefined.
 */
function resolvePath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object' && typeof cur !== 'string' && !Array.isArray(cur)) {
      return undefined;
    }
    if (part === 'length' && (typeof cur === 'string' || Array.isArray(cur))) {
      cur = cur.length;
      continue;
    }
    if (typeof cur === 'object' && cur !== null) {
      // Prototype-pollution-Schutz: nur own properties.
      if (
        part === '__proto__' ||
        part === 'constructor' ||
        part === 'prototype'
      ) {
        return undefined;
      }
      cur = (cur as Record<string, unknown>)[part];
      continue;
    }
    return undefined;
  }
  return cur;
}

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return '?';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.length} items]`;
  if (typeof v === 'object') return '[object]';
  return '?';
}

/**
 * Rendert ein Mustache-style Template gegen `toolInput`. Strip HTML, clamp 500.
 * Wenn `template` undefined → null zurueck (kein display verfuegbar).
 */
export function renderDisplayTemplate(
  template: string | undefined,
  toolInput: Record<string, unknown>,
): string | null {
  if (!template) return null;
  let rendered = template.replace(TEMPLATE_RE, (_match, path: string, previewN?: string) => {
    const v = resolvePath(toolInput, path);
    const raw = stringifyValue(v);
    if (previewN === undefined) return raw;
    // SEC-020: preview-Filter clampt einzelne Werte. Range 1..200 — beyond
    // 200 macht das full-template-clamp (500) sowieso die Arbeit.
    const n = Math.min(Math.max(parseInt(previewN, 10), 1), 200);
    if (raw.length <= n) return raw;
    return `${raw.slice(0, n - 1)}…`;
  });
  // HTML-Tags strippen
  rendered = rendered.replace(HTML_TAG_RE, '');
  if (rendered.length > MAX_RENDERED_LEN) {
    rendered = `${rendered.slice(0, MAX_RENDERED_LEN - 1)}…`;
  }
  return rendered;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomChallenge(): string {
  // 32 Byte base64url — entropy ist Brute-Force-resistent.
  const bytes = randomBytes(32);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i] ?? 0;
    bin += String.fromCharCode(v);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const DEFAULT_TTL_SEC = 5 * 60;

// ---------------------------------------------------------------------------
// Service-Factory
// ---------------------------------------------------------------------------

export interface ApprovalServiceOptions {
  readonly db: DbAdapter;
  /** Optional Clock-Override fuer Tests. */
  readonly now?: () => number;
}

export function createApprovalService(opts: ApprovalServiceOptions): ApprovalService {
  const { db } = opts;
  const now = opts.now ?? (() => Date.now());

  async function withScoped<T>(
    userId: string,
    fn: (q: { query: <R = unknown>(sql: string, params?: ReadonlyArray<unknown>) => Promise<R[]> }) => Promise<T>,
  ): Promise<T> {
    return db.transaction(userId, async (scoped) => fn(scoped));
  }

  // Lazy-Expiry-Helpers — flippen pending → expired wenn TTL abgelaufen ist,
  // BEVOR der Lese-SELECT die Rows zurueckliefert. Damit sieht die PWA nie
  // eine 'pending'-Row mit `expires_at < now`. Plan-Ref: PLAN-approval-expiry.
  // Audit-Event wird hier bewusst NICHT emittiert — wird vom cron-sweep
  // einmal pro Batch gemacht (Explore-Agent-Finding, gleicher Pattern wie v1).
  async function lazyExpireOne(
    q: { query: <R = unknown>(sql: string, params?: ReadonlyArray<unknown>) => Promise<R[]> },
    id: string,
    userId: string,
    ts: number,
  ): Promise<void> {
    await q.query(
      `UPDATE pending_approvals
          SET status = 'expired', expired_at = $1
        WHERE id = $2 AND user_id = $3
          AND status = 'pending' AND expires_at < $1`,
      [ts, id, userId],
    );
  }

  async function lazyExpireUser(
    q: { query: <R = unknown>(sql: string, params?: ReadonlyArray<unknown>) => Promise<R[]> },
    userId: string,
    ts: number,
  ): Promise<number> {
    const rows = await q.query<{ id: string }>(
      `UPDATE pending_approvals
          SET status = 'expired', expired_at = $1
        WHERE user_id = $2 AND status = 'pending' AND expires_at < $1
        RETURNING id`,
      [ts, userId],
    );
    return rows.length;
  }

  return {
    async create(args) {
      const ttlSec = args.ttlSec ?? DEFAULT_TTL_SEC;
      if (ttlSec <= 0 || ttlSec > 60 * 60) {
        throw HttpError.badRequest('invalid_request', 'ttlSec must be in (0, 3600]');
      }
      const createdAt = now();
      const expiresAt = createdAt + ttlSec * 1000;
      const rendered = renderDisplayTemplate(args.displayTemplate, args.toolInput);
      const challenge = randomChallenge();

      const row = await withScoped(args.userId, async (q) => {
        const rows = await q.query<ApprovalRowRaw>(
          `INSERT INTO pending_approvals
             (user_id, tool_name, tool_input,
              display_template, display_rendered,
              sensitivity, status,
              approval_challenge,
              request_id, origin_ip,
              created_at, expires_at)
           VALUES ($1, $2, $3,
                   $4, $5,
                   $6, 'pending',
                   $7,
                   $8, $9,
                   $10, $11)
           RETURNING ${SELECT_COLS}`,
          [
            args.userId,
            args.toolName,
            JSON.stringify(args.toolInput),
            args.displayTemplate ?? null,
            rendered,
            args.sensitivity,
            challenge,
            args.requestId ?? null,
            args.ip ?? null,
            createdAt,
            expiresAt,
          ],
        );
        const r = rows[0];
        if (!r) throw new HttpError(500, 'internal', 'approval insert returned no row');
        return r;
      });

      await emitAudit(db, {
        action: 'tool.approval.created',
        actorUserId: args.userId,
        result: 'success',
        ...(args.requestId ? { requestId: args.requestId } : {}),
        ...(args.ip ? { ip: args.ip } : {}),
        details: {
          approval_id: row.id,
          tool_name: args.toolName,
          sensitivity: args.sensitivity,
          ttl_sec: ttlSec,
        },
      });

      return rowToApproval(row);
    },

    async get(args) {
      const ts = now();
      const row = await withScoped(args.userId, async (q) => {
        // Lazy-Expire vor dem SELECT (in derselben Tx — kein TOCTOU-Race).
        await lazyExpireOne(q, args.id, args.userId, ts);
        const rows = await q.query<ApprovalRowRaw>(
          `SELECT ${SELECT_COLS} FROM pending_approvals WHERE id = $1 AND user_id = $2`,
          [args.id, args.userId],
        );
        return rows[0] ?? null;
      });
      return row ? rowToApproval(row) : null;
    },

    async list(args) {
      const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
      const ts = now();
      const rows = await withScoped(args.userId, async (q) => {
        // Lazy-Expire vor dem SELECT — sicherzustellen dass abgelaufene Rows
        // nicht mehr als pending zurueckkommen, egal welcher Status-Filter
        // gerade aktiv ist.
        await lazyExpireUser(q, args.userId, ts);
        if (args.status) {
          return q.query<ApprovalRowRaw>(
            `SELECT ${SELECT_COLS} FROM pending_approvals
             WHERE user_id = $1 AND status = $2
             ORDER BY created_at DESC
             LIMIT $3`,
            [args.userId, args.status, limit],
          );
        }
        return q.query<ApprovalRowRaw>(
          `SELECT ${SELECT_COLS} FROM pending_approvals
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT $2`,
          [args.userId, limit],
        );
      });
      return rows.map(rowToApproval);
    },

    async approve(args) {
      const ts = now();
      const row = await withScoped(args.userId, async (q) => {
        const current = await q.query<ApprovalRowRaw>(
          `SELECT ${SELECT_COLS} FROM pending_approvals WHERE id = $1 AND user_id = $2`,
          [args.id, args.userId],
        );
        const existing = current[0];
        if (!existing) {
          throw HttpError.notFound('approval not found');
        }
        if (existing.status !== 'pending') {
          throw new ApprovalConflictError(args.id, existing.status as ApprovalStatus);
        }
        if (toNumber(existing.expires_at) !== null && toNumber(existing.expires_at)! < ts) {
          // Auto-flip auf expired bei stale Eintrag.
          await q.query(
            `UPDATE pending_approvals SET status = 'expired', expired_at = $1
             WHERE id = $2 AND status = 'pending'`,
            [ts, args.id],
          );
          throw new ApprovalConflictError(args.id, 'expired');
        }
        const updated = await q.query<ApprovalRowRaw>(
          `UPDATE pending_approvals
             SET status = 'approved',
                 approval_signature = $1,
                 approved_at = $2,
                 prf_session_id = $3
           WHERE id = $4 AND user_id = $5 AND status = 'pending'
           RETURNING ${SELECT_COLS}`,
          [
            args.signature,
            ts,
            args.prfSessionId ?? null,
            args.id,
            args.userId,
          ],
        );
        const r = updated[0];
        if (!r) {
          // Race: jemand hat parallel approved/rejected.
          throw new ApprovalConflictError(args.id, 'unknown');
        }
        return r;
      });

      await emitAudit(db, {
        action: 'tool.approval.approved',
        actorUserId: args.userId,
        result: 'success',
        ...(row.request_id ? { requestId: row.request_id } : {}),
        details: {
          approval_id: row.id,
          tool_name: row.tool_name,
          sensitivity: row.sensitivity,
          prf_session_bound: args.prfSessionId !== undefined,
        },
      });

      return rowToApproval(row);
    },

    async reject(args) {
      const ts = now();
      const row = await withScoped(args.userId, async (q) => {
        const current = await q.query<ApprovalRowRaw>(
          `SELECT ${SELECT_COLS} FROM pending_approvals WHERE id = $1 AND user_id = $2`,
          [args.id, args.userId],
        );
        const existing = current[0];
        if (!existing) {
          throw HttpError.notFound('approval not found');
        }
        if (existing.status !== 'pending') {
          throw new ApprovalConflictError(args.id, existing.status as ApprovalStatus);
        }
        const updated = await q.query<ApprovalRowRaw>(
          `UPDATE pending_approvals
             SET status = 'rejected',
                 rejected_at = $1,
                 rejection_reason = $2
           WHERE id = $3 AND user_id = $4 AND status = 'pending'
           RETURNING ${SELECT_COLS}`,
          [ts, args.reason ?? null, args.id, args.userId],
        );
        const r = updated[0];
        if (!r) {
          throw new ApprovalConflictError(args.id, 'unknown');
        }
        return r;
      });

      await emitAudit(db, {
        action: 'tool.approval.rejected',
        actorUserId: args.userId,
        result: 'success',
        ...(row.request_id ? { requestId: row.request_id } : {}),
        details: {
          approval_id: row.id,
          tool_name: row.tool_name,
          sensitivity: row.sensitivity,
          reason: args.reason ?? null,
        },
      });

      return rowToApproval(row);
    },

    async sweepExpired() {
      const ts = now();
      const raw = db.unsafe('approval_sweep_expired');
      const rows = await raw.query<{ id: string }>(
        `UPDATE pending_approvals
           SET status = 'expired', expired_at = $1
         WHERE status = 'pending' AND expires_at < $1
         RETURNING id`,
        [ts],
      );
      if (rows.length > 0) {
        await emitAudit(db, {
          action: 'tool.approval.sweep_expired',
          actorUserId: null,
          result: 'success',
          details: { count: rows.length },
        });
      }
      return rows.length;
    },

    async setResult(args) {
      // SEC-018: single-write-Guard — verhindert dass ein zweiter Dispatch
      // (gleiche approval_id) das erste Result ueberschreibt. Mit dem CAS
      // auf `result_emitted_at IS NULL` ist setResult idempotent: erste
      // erfolgreiche Schreib gewinnt, alle weiteren werden im UPDATE
      // gedropped. Wir werfen kein Error im no-op-Fall, weil Caller die
      // result-Row separat re-fetcht.
      const ts = now();
      const raw = db.unsafe('approval_set_result');
      await raw.query(
        `UPDATE pending_approvals
           SET result_json = $1, result_emitted_at = $2
         WHERE id = $3 AND result_emitted_at IS NULL`,
        [JSON.stringify(args.result), ts, args.id],
      );
    },
  };
}
