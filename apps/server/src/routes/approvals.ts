/**
 * Approvals-HTTP-Routes — PWA-facing Approval-Sign-Off-Flow.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2 (Request-Lifecycle Step 5-9), §11 Phase 4.
 *
 * Endpunkte:
 *   GET    /v1/approvals                  — list (pending+recent, own)
 *   GET    /v1/approvals/:id              — read single (own)
 *   POST   /v1/approvals/:id/approve      — body: { signatureB64, prfSessionId? }
 *   POST   /v1/approvals/:id/reject       — body: { reason? }
 *   GET    /v1/approvals/:id/result       — poll result (after approve)
 *
 * Auth: Bearer-Session-JWT. RLS enforct owner-only.
 *
 * Post-Approve-Trigger: nach erfolgreichem `approve()` triggert die Route
 * `resumeApproval()` und persistiert das Tool-Result. Dann antwortet der
 * Approve-Endpoint mit `{ status: 'approved', result_emitted_at }`. PWA
 * kann `/result` pollen ODER direkt den Body interpretieren.
 *
 * Schedule:
 *   Long-poll auf `/result`: HTTP-keep-alive, max 25s wait, dann 304-ish
 *   Empty-Result. PWA macht erneuten GET. Phase-4 implementiert nur die
 *   Short-Poll-Variante; Long-Poll bleibt offen (TODO Phase 5).
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppBindings, ServerContext } from '../lib/context.js';
import { HttpError } from '../lib/errors.js';
import { resolveOrigin, resolveRpId } from '../lib/config.js';
import { auth } from '../middleware/auth.js';
import type { PendingApproval, ApprovalStatus } from '../schema/types.js';
import {
  ApprovalConflictError,
  type ApprovalService,
} from '../services/approvals.js';
import { resumeApproval } from '../mcp/protocol/approval-resume.js';
import type { ToolRegistry } from '../mcp/protocol/registry.js';
import type { AuditService } from '../mcp/protocol/tool.js';
import type { VerifyApprovalAssertionArgs } from '../auth/webauthn/approval-verify.js';

/**
 * Verifier-Callback fuer WebAuthn-Assertion (SEC-001). In tests koennen wir
 * den injizieren (no-op); in production wird `createApprovalAssertionVerifier`
 * verwendet (siehe app-factory.ts).
 */
export type ApprovalAssertionVerifier = (args: VerifyApprovalAssertionArgs) => Promise<void>;

export interface ApprovalsRouteDeps {
  readonly server: ServerContext;
  readonly approvals: ApprovalService;
  readonly registry: ToolRegistry;
  readonly audit: AuditService;
  /** Optional fuer Tests; in Production zwingend gesetzt (SEC-001). */
  readonly verifyAssertion?: ApprovalAssertionVerifier;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

// SEC-001: ein /approve-Call MUSS die vollstaendige WebAuthn-Assertion mit-
// senden (credentialId + authenticatorData + clientDataJson + signature). Ohne
// diese Felder kann der Server keine Verifikation gegen die in
// pending_approvals.approval_challenge gespeicherte Challenge fahren. Die
// Felder sind required — wer nur signature alleine schickt, wird mit 400
// abgelehnt.
const approveSchema = z.object({
  credentialIdB64: z.string().min(1).max(1024),
  authenticatorDataB64: z.string().min(1).max(8192),
  clientDataJsonB64: z.string().min(1).max(8192),
  signatureB64: z.string().min(1).max(8192),
  userHandleB64: z.string().min(1).max(256).optional(),
  prfSessionId: z.string().min(1).max(128).optional(),
});

const rejectSchema = z.object({
  reason: z.string().max(500).optional(),
});

const listQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'expired']).optional(),
  /**
   * Comma-separated Liste fuer Multi-Status-Filter (Archive-View):
   * `?statusIn=approved,rejected,expired`. Hat Vorrang vor `status`.
   */
  statusIn: z.string().optional(),
  /**
   * Min created_at (Unix-ms). `?sinceMs=…` z.B. 24h-Window fuer Archive.
   */
  sinceMs: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const ALLOWED_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;
type AllowedStatus = (typeof ALLOWED_STATUSES)[number];

function parseStatusIn(raw: string | undefined): AllowedStatus[] | undefined {
  if (!raw) return undefined;
  const out: AllowedStatus[] = [];
  for (const s of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    if ((ALLOWED_STATUSES as readonly string[]).includes(s)) {
      out.push(s as AllowedStatus);
    }
  }
  return out.length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// b64 helpers
// ---------------------------------------------------------------------------

function b64ToBytes(b64: string): Uint8Array {
  const norm = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] ?? 0);
  return btoa(s);
}

// ---------------------------------------------------------------------------
// Serialization (PendingApproval → JSON)
// ---------------------------------------------------------------------------

function approvalToJson(
  a: PendingApproval,
  extras?: { allowCredentialIdsB64?: ReadonlyArray<string> },
): Record<string, unknown> {
  return {
    id: a.id,
    userId: a.userId,
    toolName: a.toolName,
    toolInput: a.toolInput,
    displayTemplate: a.displayTemplate,
    displayRendered: a.displayRendered,
    sensitivity: a.sensitivity,
    status: a.status,
    approvalChallenge: a.approvalChallenge,
    // PWA-facing Alias — der Client kennt das Feld als `challengeB64`.
    // Beide Felder zeigen auf dieselbe Bytes-Source (b64url, 32 random bytes
    // aus randomChallenge()).
    challengeB64: a.approvalChallenge,
    ...(extras?.allowCredentialIdsB64
      ? { allowCredentialIdsB64: extras.allowCredentialIdsB64 }
      : {}),
    approvalSignatureB64: a.approvalSignature ? bytesToB64(a.approvalSignature) : null,
    approvedAt: a.approvedAt,
    rejectedAt: a.rejectedAt,
    rejectionReason: a.rejectionReason,
    expiredAt: a.expiredAt,
    prfSessionBound: a.prfSessionId !== null,
    resultJson: a.resultJson,
    resultEmittedAt: a.resultEmittedAt,
    requestId: a.requestId,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    extensionCount: a.extensionCount ?? 0,
    defaultsApplied: a.defaultsApplied ?? [],
  };
}

/**
 * Laedt die credential_id-Liste des Users — fuer `allowCredentials` im
 * WebAuthn-`navigator.credentials.get()`-Call. Wenn der User mehrere Passkeys
 * hat, kann der Browser den richtigen ansprechen.
 *
 * RLS-scoped, nur own Credentials.
 */
async function loadAllowCredentialIds(
  server: ServerContext,
  userId: string,
): Promise<string[]> {
  const scoped = await server.db.scoped(userId);
  const rows = await scoped.query<{ credentialId: string | Uint8Array | Buffer }>(
    `SELECT credential_id AS "credentialId"
       FROM webauthn_credentials
      WHERE user_id = $1 AND invalidated_at IS NULL`,
    [userId],
  );
  // BYTEA-Spalte: postgres-js liefert Uint8Array. JSON.stringify wuerde das
  // als {0:n,1:n,...} serialisieren — die PWA bekommt damit kein b64url
  // sondern ein Object und schmiert beim atob() ab.
  //
  // Dual-encoding-Fallback: alte Inserts haben den b64url-String als ASCII-
  // Bytes gespeichert (siehe authentication.ts dual-lookup-Kommentar). Neue
  // Inserts haben die binaer-decodierten credential-bytes. Heuristik: wenn
  // alle Bytes im b64url-Alphabet liegen, geben wir den ASCII-decoded String
  // direkt zurueck; sonst encoden wir die Binaer-Bytes nach b64url.
  return rows.map((r) => normalizeCredIdToB64Url(r.credentialId));
}

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

function normalizeCredIdToB64Url(raw: string | Uint8Array | Buffer): string {
  if (typeof raw === 'string') return raw;
  // postgres-js BYTEA → Uint8Array. Falls Node-Buffer (Hono/JSON-Roundtrip),
  // ist es bereits Uint8Array-subtype.
  const bytes = raw as Uint8Array;
  // ASCII-decode probieren — wenn das Ergebnis im b64url-Alphabet liegt,
  // war's eine alte ASCII-Insert; sonst neuer Binaer-Insert.
  try {
    const ascii = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (B64URL_RE.test(ascii)) return ascii;
  } catch {
    /* fall through to binary path */
  }
  return bytesToB64Url(bytes);
}

function bytesToB64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] ?? 0);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function approvalsRoutes(deps: ApprovalsRouteDeps): Hono<AppBindings> {
  const { server, approvals, registry, audit, verifyAssertion } = deps;
  const app = new Hono<AppBindings>();
  const guard = auth(server);

  // GET /v1/approvals
  // Query-Params:
  //   ?status=pending|approved|rejected|expired
  //   ?statusIn=approved,rejected,expired   (Multi-Filter, Vorrang)
  //   ?sinceMs=<unix-ms>                    (Archive: 24h-Window)
  //   ?limit=<n>
  app.get('/v1/approvals', guard, async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const q = listQuerySchema.safeParse({
      status: c.req.query('status'),
      statusIn: c.req.query('statusIn'),
      sinceMs: c.req.query('sinceMs'),
      limit: c.req.query('limit'),
    });
    if (!q.success) {
      throw HttpError.badRequest('invalid_request', 'invalid query', {
        issues: q.error.issues,
      });
    }
    const statusIn = parseStatusIn(q.data.statusIn);
    const listArgs: {
      userId: string;
      status?: ApprovalStatus;
      statusIn?: ReadonlyArray<ApprovalStatus>;
      sinceMs?: number;
      limit?: number;
    } = { userId: principal.userId };
    if (statusIn) listArgs.statusIn = statusIn;
    else if (q.data.status) listArgs.status = q.data.status;
    if (q.data.sinceMs !== undefined) listArgs.sinceMs = q.data.sinceMs;
    if (q.data.limit !== undefined) listArgs.limit = q.data.limit;
    const list = await approvals.list(listArgs);
    return c.json({ approvals: list.map((a) => approvalToJson(a)) });
  });

  // GET /v1/approvals/:id
  // Liefert die Approval inkl. `challengeB64` + `allowCredentialIdsB64` damit
  // die PWA direkt `navigator.credentials.get(...)` triggern kann ohne einen
  // separaten /challenge-Roundtrip.
  app.get('/v1/approvals/:id', guard, async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const id = c.req.param('id');
    const row = await approvals.get({ id, userId: principal.userId });
    if (!row) throw HttpError.notFound('approval not found');
    const allowCredentialIdsB64 = await loadAllowCredentialIds(server, principal.userId);
    return c.json({ approval: approvalToJson(row, { allowCredentialIdsB64 }) });
  });

  // POST /v1/approvals/:id/approve
  // SEC-001: Verifiziert die WebAuthn-Assertion VOR dem Status-Flip. Wenn die
  // Verifikation failt, bleibt die Approval auf 'pending' und der User sieht
  // 401. Erst NACH erfolgreichem Verify wird `approvals.approve()` gerufen.
  app.post(
    '/v1/approvals/:id/approve',
    guard,
    zValidator('json', approveSchema),
    async (c) => {
      const principal = c.get('user');
      if (!principal) throw HttpError.unauthorized();
      const id = c.req.param('id');
      const body = c.req.valid('json');
      const signature = b64ToBytes(body.signatureB64);

      // Existing approval laden (fuer expectedChallenge). Bei wrong-user oder
      // missing → 404. Bei status != pending → 409 schon hier.
      const existing = await approvals.get({ id, userId: principal.userId });
      if (!existing) throw HttpError.notFound('approval not found');
      if (existing.status !== 'pending') {
        return c.json(
          {
            error: {
              code: 'conflict',
              message: `approval ${id} not pending (status=${existing.status})`,
              details: { currentStatus: existing.status },
            },
          },
          409,
        );
      }
      if (!existing.approvalChallenge) {
        throw new HttpError(500, 'internal', 'approval missing challenge');
      }

      // SEC-001 verify: bei fehlendem verifier (alte Tests, lokales Dev ohne
      // Wiring) skippen wir die Verifikation. In Production-app-factory.ts
      // wird der verifier IMMER gesetzt — ein production-Server ohne
      // verifier wuerde im Boot via assertion (siehe app-factory.ts) early
      // fail-closed sterben.
      if (verifyAssertion) {
        const origin = resolveOrigin(c.req.raw, server.config);
        const rpId = resolveRpId(origin, server.config);
        const assertion = {
          credentialIdB64: body.credentialIdB64,
          authenticatorDataB64: body.authenticatorDataB64,
          clientDataJsonB64: body.clientDataJsonB64,
          signatureB64: body.signatureB64,
          ...(body.userHandleB64 ? { userHandleB64: body.userHandleB64 } : {}),
        };
        try {
          await verifyAssertion({
            userId: principal.userId,
            approvalId: id,
            expectedChallenge: existing.approvalChallenge,
            expectedOrigin: origin,
            expectedRpId: rpId,
            assertion,
          });
        } catch (err) {
          // Audit-Trail fuer failed approval-attempts (BLAST-RADIUS: User
          // sees nur 401, der security-relevante Event landet im audit_log).
          await audit
            .emit({
              action: 'tool.approval.verify_failed',
              actorUserId: principal.userId,
              result: 'failure',
              ...(c.get('requestId') ? { requestId: c.get('requestId')! } : {}),
              details: {
                approval_id: id,
                tool_name: existing.toolName,
                reason: err instanceof Error ? err.message : 'unknown',
              },
            })
            .catch(() => {
              /* audit failure is non-fatal */
            });
          throw err;
        }
      }

      try {
        const approval = await approvals.approve({
          id,
          userId: principal.userId,
          signature,
          ...(body.prfSessionId ? { prfSessionId: body.prfSessionId } : {}),
        });

        // Resume Tool-Dispatch synchron. Bei Tool-Error: setResult(error) +
        // werfen → Caller sieht 500, PWA sieht result_json.ok=false beim Re-Read.
        let resumeError: unknown = null;
        try {
          await resumeApproval(
            {
              approval,
              principal,
              server,
              registry,
              audit,
              requestId: c.get('requestId'),
            },
            approvals,
          );
        } catch (err) {
          resumeError = err;
        }

        // Approval-Row neu laden — setResult hat result_json.emitted_at gesetzt.
        const refreshed = await approvals.get({ id, userId: principal.userId });
        return c.json({
          approval: refreshed ? approvalToJson(refreshed) : approvalToJson(approval),
          resume_error: resumeError
            ? resumeError instanceof Error
              ? resumeError.message
              : 'unknown'
            : null,
        });
      } catch (err) {
        if (err instanceof ApprovalConflictError) {
          return c.json(
            {
              error: {
                code: 'conflict',
                message: err.message,
                details: { currentStatus: err.currentStatus },
              },
            },
            409,
          );
        }
        throw err;
      }
    },
  );

  // POST /v1/approvals/:id/reject
  app.post(
    '/v1/approvals/:id/reject',
    guard,
    zValidator('json', rejectSchema),
    async (c) => {
      const principal = c.get('user');
      if (!principal) throw HttpError.unauthorized();
      const id = c.req.param('id');
      const body = c.req.valid('json');
      try {
        const rejectArgs: { id: string; userId: string; reason?: string } = {
          id,
          userId: principal.userId,
        };
        if (body.reason !== undefined) rejectArgs.reason = body.reason;
        const row = await approvals.reject(rejectArgs);
        return c.json({ approval: approvalToJson(row) });
      } catch (err) {
        if (err instanceof ApprovalConflictError) {
          return c.json(
            {
              error: {
                code: 'conflict',
                message: err.message,
                details: { currentStatus: err.currentStatus },
              },
            },
            409,
          );
        }
        throw err;
      }
    },
  );

  // POST /v1/approvals/:id/extend
  // Body: { minutes: 5 } — verlaengert die TTL eines pending-Approvals.
  // Max 3 Extensions pro Row (= 15 min Budget), Limit im ApprovalService.
  app.post('/v1/approvals/:id/extend', guard, async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const id = c.req.param('id');
    let body: { minutes?: number } = {};
    try {
      const raw = await c.req.json();
      if (raw && typeof raw === 'object') body = raw as { minutes?: number };
    } catch {
      /* default to 5 min */
    }
    const minutes = typeof body.minutes === 'number' ? body.minutes : 5;
    if (![5, 10, 15].includes(minutes)) {
      throw HttpError.badRequest('invalid_request', 'minutes must be 5, 10, or 15');
    }
    try {
      const updated = await approvals.extendTtl({
        id,
        userId: principal.userId,
        extensionMs: minutes * 60 * 1000,
      });
      return c.json({ approval: approvalToJson(updated) });
    } catch (err) {
      if (err instanceof ApprovalConflictError) {
        return c.json(
          {
            error: {
              code: 'conflict',
              message: `approval ${id} cannot be extended (status=${err.currentStatus})`,
              details: { currentStatus: err.currentStatus },
            },
          },
          409,
        );
      }
      throw err;
    }
  });

  // GET /v1/approvals/:id/result
  app.get('/v1/approvals/:id/result', guard, async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const id = c.req.param('id');
    const row = await approvals.get({ id, userId: principal.userId });
    if (!row) throw HttpError.notFound('approval not found');
    if (row.resultEmittedAt === null || row.resultJson === null) {
      return c.json(
        {
          status: row.status,
          result_emitted_at: null,
          result: null,
        },
        202,
      );
    }
    return c.json({
      status: row.status,
      result_emitted_at: row.resultEmittedAt,
      result: row.resultJson,
    });
  });

  return app;
}
