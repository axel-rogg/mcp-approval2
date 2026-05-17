/**
 * EmailOutboxService — kombiniert EmailAdapter-send mit persistenter Outbox.
 *
 * Multi-User Tier 1 (2026-05-17):
 *
 *   sendAndPersist(args) — schickt via EmailAdapter, schreibt parallel
 *     einen email_outbox-Eintrag. Bei adapter-fail wird die Row mit
 *     status='failed' geschrieben + Error wird nicht re-thrown (fail-soft);
 *     Caller-Route entscheidet via return-value ob er dem User einen Hint
 *     gibt ("Email konnte nicht zugestellt werden — Admin sieht den Link
 *     in der PWA-Outbox").
 *
 *   listOutbox(args) — admin-only. Letzte N Mails mit Filter (kind,
 *     status). PWA-UI rendert die Liste + Link-Copy + "manually dispatched"-
 *     Markierung.
 *
 *   markDispatched(id) — admin-only. Setzt manually_dispatched_at jetzt.
 *
 * Sicherheit:
 *   - sendAndPersist wird vom Server-Code mit fully-rendered body gerufen
 *     — der enthaelt die rohen Tokens. Body wird in der DB gespeichert
 *     (encrypted-at-rest via Postgres-TDE / Neon-side, aber NICHT App-DEK-
 *     encrypted; das waere overkill da Outbox eh admin-only ist und
 *     Tokens sowieso nach 24h expiren).
 *   - listOutbox/markDispatched MUSS principal.role === 'admin' checken,
 *     bevor sie laufen. App-Layer-Gate — keine RLS-Policy.
 */
import type { DbAdapter, EmailAdapter } from '@mcp-approval2/adapters';
import { EmailSendError } from '@mcp-approval2/adapters';
import { HttpError } from '../lib/errors.js';

export type EmailKind = 'invite' | 'recovery' | 'notification';

export interface SendAndPersistArgs {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly kind: EmailKind;
  /** Optional — wenn der to-User in approval2 bekannt ist (z.B. Recovery). */
  readonly toUserId?: string;
  /** Optional — wer hat die Email getriggert (Admin bei Invite, niemand bei recovery-self-serve). */
  readonly actorUserId?: string;
  readonly replyTo?: string;
}

export interface SendAndPersistResult {
  readonly outboxId: string;
  readonly provider: string;
  readonly providerMessageId: string | null;
  /** 'sent' = Adapter hat 200 returnt; 'failed' = Adapter wirf EmailSendError; 'logged' = console-adapter (kein echter send). */
  readonly status: 'sent' | 'failed' | 'logged';
  readonly errorDetail: string | null;
}

export interface ListOutboxArgs {
  readonly principalRole: 'admin' | 'member';
  readonly kind?: EmailKind;
  readonly status?: 'sent' | 'failed' | 'logged';
  readonly limit?: number;
}

export interface OutboxRow {
  readonly id: string;
  readonly toUserId: string | null;
  readonly toEmail: string;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly bodyText: string;
  readonly kind: EmailKind;
  readonly provider: string;
  readonly providerMessageId: string | null;
  readonly status: 'sent' | 'failed' | 'logged';
  readonly errorDetail: string | null;
  readonly createdAt: number;
  readonly manuallyDispatchedAt: number | null;
}

export interface MarkDispatchedArgs {
  readonly principalRole: 'admin' | 'member';
  readonly outboxId: string;
}

export interface ResendOutboxArgs {
  readonly principalRole: 'admin' | 'member';
  readonly outboxId: string;
}

export interface ResendOutboxResult {
  readonly status: 'sent' | 'failed' | 'logged';
  readonly provider: string;
  readonly providerMessageId: string | null;
  readonly errorDetail: string | null;
}

export interface EmailOutboxService {
  sendAndPersist(args: SendAndPersistArgs): Promise<SendAndPersistResult>;
  listOutbox(args: ListOutboxArgs): Promise<OutboxRow[]>;
  markDispatched(args: MarkDispatchedArgs): Promise<void>;
  /**
   * Admin-only: laedt eine existing outbox-row + re-schickt sie via
   * EmailAdapter. Status + provider_message_id der Row werden upgedated.
   * Sinnvoll bei status=failed (transient API-Fail) oder status=logged
   * (User wechselte vom console- auf den resend-Provider).
   */
  resend(args: ResendOutboxArgs): Promise<ResendOutboxResult>;
}

export interface EmailOutboxServiceOptions {
  readonly db: DbAdapter;
  /** Wenn ungesetzt: alles wird als 'logged' status gespeichert (no send). */
  readonly email?: EmailAdapter;
  /** Optional now-Override fuer Tests. */
  readonly now?: () => number;
}

interface RawOutboxRow {
  readonly id: string;
  readonly to_user_id: string | null;
  readonly to_email: string;
  readonly subject: string;
  readonly body_html: string;
  readonly body_text: string;
  readonly kind: string;
  readonly provider: string;
  readonly provider_message_id: string | null;
  readonly status: string;
  readonly error_detail: string | null;
  readonly created_at: string | number;
  readonly manually_dispatched_at: string | number | null;
}

function toNumOrNull(v: string | number | null): number | null {
  if (v === null) return null;
  return typeof v === 'number' ? v : Number(v);
}

function rowToOutbox(r: RawOutboxRow): OutboxRow {
  return {
    id: r.id,
    toUserId: r.to_user_id,
    toEmail: r.to_email,
    subject: r.subject,
    bodyHtml: r.body_html,
    bodyText: r.body_text,
    kind: r.kind as EmailKind,
    provider: r.provider,
    providerMessageId: r.provider_message_id,
    status: r.status as 'sent' | 'failed' | 'logged',
    errorDetail: r.error_detail,
    createdAt: toNumOrNull(r.created_at) ?? 0,
    manuallyDispatchedAt: toNumOrNull(r.manually_dispatched_at),
  };
}

function requireAdmin(role: 'admin' | 'member'): void {
  if (role !== 'admin') {
    throw HttpError.forbidden('forbidden', 'admin-only resource');
  }
}

export function createEmailOutboxService(
  opts: EmailOutboxServiceOptions,
): EmailOutboxService {
  const { db, email } = opts;
  const now = opts.now ?? (() => Date.now());

  return {
    async sendAndPersist(args) {
      let provider = email?.providerName ?? 'console';
      let providerMessageId: string | null = null;
      let status: 'sent' | 'failed' | 'logged' = 'logged';
      let errorDetail: string | null = null;

      if (email) {
        try {
          const result = await email.send({
            to: args.to,
            subject: args.subject,
            html: args.html,
            text: args.text,
            ...(args.replyTo ? { replyTo: args.replyTo } : {}),
          });
          provider = result.provider;
          providerMessageId = result.id;
          // ConsoleAdapter ist ein "logged"-Send, nicht echtes "sent" —
          // Admin muss manuell zustellen. Resend ist echtes "sent".
          status = provider === 'console' ? 'logged' : 'sent';
        } catch (err) {
          status = 'failed';
          if (err instanceof EmailSendError) {
            errorDetail = `${err.providerDetail} (status=${err.status ?? 'n/a'})`;
          } else {
            errorDetail = err instanceof Error ? err.message : String(err);
          }
        }
      }

      // Outbox-INSERT immer, auch bei failure — Admin braucht den Link
      // damit er manuell zustellen kann.
      const raw = db.unsafe('email_outbox_insert');
      const rows = await raw.query<{ id: string }>(
        `INSERT INTO email_outbox
           (to_user_id, to_email, subject, body_html, body_text, kind,
            provider, provider_message_id, status, error_detail, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          args.toUserId ?? null,
          args.to,
          args.subject,
          args.html,
          args.text,
          args.kind,
          provider,
          providerMessageId,
          status,
          errorDetail,
          now(),
        ],
      );
      const outboxId = rows[0]?.id;
      if (!outboxId) {
        throw new HttpError(500, 'internal', 'email_outbox insert returned no row');
      }
      return { outboxId, provider, providerMessageId, status, errorDetail };
    },

    async listOutbox(args) {
      requireAdmin(args.principalRole);
      const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
      const raw = db.unsafe('email_outbox_list');
      const where: string[] = [];
      const params: unknown[] = [];
      if (args.kind) {
        params.push(args.kind);
        where.push(`kind = $${params.length}`);
      }
      if (args.status) {
        params.push(args.status);
        where.push(`status = $${params.length}`);
      }
      params.push(limit);
      const sql = `SELECT id, to_user_id, to_email, subject, body_html, body_text,
                          kind, provider, provider_message_id, status, error_detail,
                          created_at, manually_dispatched_at
                     FROM email_outbox
                     ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
                     ORDER BY created_at DESC
                     LIMIT $${params.length}`;
      const rows = await raw.query<RawOutboxRow>(sql, params);
      return rows.map(rowToOutbox);
    },

    async markDispatched(args) {
      requireAdmin(args.principalRole);
      const raw = db.unsafe('email_outbox_mark_dispatched');
      await raw.query(
        `UPDATE email_outbox SET manually_dispatched_at = $1
          WHERE id = $2 AND manually_dispatched_at IS NULL`,
        [now(), args.outboxId],
      );
    },

    async resend(args) {
      requireAdmin(args.principalRole);
      const raw = db.unsafe('email_outbox_resend_load');
      const rows = await raw.query<{
        toEmail: string;
        subject: string;
        bodyHtml: string;
        bodyText: string;
      }>(
        `SELECT to_email AS "toEmail", subject, body_html AS "bodyHtml", body_text AS "bodyText"
           FROM email_outbox WHERE id = $1 LIMIT 1`,
        [args.outboxId],
      );
      const row = rows[0];
      if (!row) {
        throw new HttpError(404, 'not_found', `outbox row ${args.outboxId} not found`);
      }

      let provider = email?.providerName ?? 'console';
      let providerMessageId: string | null = null;
      let status: 'sent' | 'failed' | 'logged' = 'logged';
      let errorDetail: string | null = null;

      if (email) {
        try {
          const result = await email.send({
            to: row.toEmail,
            subject: row.subject,
            html: row.bodyHtml,
            text: row.bodyText,
          });
          provider = result.provider;
          providerMessageId = result.id;
          status = provider === 'console' ? 'logged' : 'sent';
        } catch (err) {
          status = 'failed';
          if (err instanceof EmailSendError) {
            errorDetail = `${err.providerDetail} (status=${err.status ?? 'n/a'})`;
          } else {
            errorDetail = err instanceof Error ? err.message : String(err);
          }
        }
      }

      // Update existing row in-place (kein neuer Eintrag — Audit-Trail von
      // "neuer Versuch" lebt im provider_message_id-Wechsel + created_at
      // bleibt der originale Zeitpunkt).
      const upd = db.unsafe('email_outbox_resend_update');
      await upd.query(
        `UPDATE email_outbox
            SET provider = $1, provider_message_id = $2, status = $3,
                error_detail = $4, manually_dispatched_at = NULL
          WHERE id = $5`,
        [provider, providerMessageId, status, errorDetail, args.outboxId],
      );

      return { status, provider, providerMessageId, errorDetail };
    },
  };
}
