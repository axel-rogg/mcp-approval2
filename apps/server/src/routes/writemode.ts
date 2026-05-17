/**
 * Writemode-Routes — HMAC-gated Smoke-Test-Pfad.
 *
 *   POST /writemode/start  — Body: { expires_at: number, hmac_sig: string }
 *                            → oeffnet ein granted-window (in-memory) wenn HMAC valid
 *   POST /writemode/stop   — Body: { hmac_sig: string } → schliesst window
 *
 * Plan-Ref: docs/plans/done/PLAN-prefs.md + mcp-approval/src/writemode/smoke.ts.
 *
 * HMAC-Key: env.SMOKE_TEST_KEY. Signature ist HMAC-SHA-256 ueber:
 *   - start: `${expires_at}` (ASCII-decimal)
 *   - stop:  `stop` (literal string)
 *
 * Sicherheits-Bemerkungen:
 *   - Production hat SMOKE_TEST_KEY NICHT gesetzt → Routes geben 404 (kein
 *     Lebenszeichen, kein 503 — wir wollen die Existenz des Pfades nicht
 *     leaken).
 *   - Smoke-Window ist process-local. Mehrere Server-Replicas haetten je
 *     einen — fuer Layer-3-Smoke gegen genau einen Worker reicht das.
 *   - max-window: 15 min (kurzer Blast-Radius bei Key-Leak).
 *   - constant-time signature compare.
 *
 * Was hier KEIN Approval-Bypass tut: dieses Modul liefert nur das Window-State.
 * Tools/Approval-Service muessen `isWritemodeActive()` selbst checken, wenn sie
 * den Bypass nutzen wollen. So vermeiden wir, dass das Smoke-Window ohne
 * explizite Opt-In-Lookup eine Sicherheitsluecke wird.
 */
import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AppBindings, ServerContext } from '../lib/context.js';
import { HttpError } from '../lib/errors.js';
import { auth } from '../middleware/auth.js';
import { resolveOrigin, resolveRpId } from '../lib/config.js';
import type {
  WritemodeService,
  WritemodeDuration,
} from '../services/writemode.js';
import { VALID_DURATIONS } from '../services/writemode.js';
import type { VerifyWritemodeActivationArgs } from '../auth/webauthn/writemode-activation-verify.js';
import { emitAudit } from '../services/audit.js';

const MAX_WINDOW_MS = 15 * 60 * 1000; // 15 min
// Activation-Challenge: das Body-Field `ts` darf max so weit driften vom
// Server-Now. Wider als Round-Trip, schmaler damit ein stolener Assertion
// nicht Stunden spaeter re-aktiviert werden kann (analog v1).
const ACTIVATE_TS_SKEW_MS = 5 * 60 * 1000;

const StartBodySchema = z
  .object({
    expires_at: z.number().int().positive(),
    hmac_sig: z.string().min(1).max(256),
  })
  .strict();

const StopBodySchema = z
  .object({
    hmac_sig: z.string().min(1).max(256),
  })
  .strict();

export interface WritemodeState {
  activeUntil: number;
  activatedAt: number;
}

export interface WritemodeRouteDeps {
  /**
   * Pre-shared HMAC key. When undefined (Production-default), routes return 404.
   */
  readonly smokeTestKey?: string | undefined;
  /**
   * In-memory state container. Caller (createApp) shares a single instance
   * between routes + Approval-Service, sodass alle Komponenten dasselbe Window
   * sehen. Default: lokal frische `{ activeUntil: 0, activatedAt: 0 }`.
   */
  readonly state?: WritemodeState;
  /** Test-Helper: Uhrzeit ueber Fixed-Now ersetzbar. */
  readonly now?: () => number;
}

/**
 * Public-Accessor: ist gerade ein writemode-Window aktiv?
 * Caller (Approval-Service) prueft pro Tool-Call.
 */
export function isWritemodeActive(
  state: WritemodeState,
  nowMs: number = Date.now(),
): boolean {
  return state.activeUntil > nowMs;
}

function jsonError(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

function verifyHmac(key: string, message: string, hexSig: string): boolean {
  // Reject anything not hex/lowercase-safe — `timingSafeEqual` throws on
  // mismatched lengths, but our hex-test already filters that out.
  if (!/^[0-9a-fA-F]+$/.test(hexSig)) return false;
  const expected = createHmac('sha256', key).update(message).digest();
  let presented: Buffer;
  try {
    presented = Buffer.from(hexSig, 'hex');
  } catch {
    return false;
  }
  if (presented.byteLength !== expected.byteLength) return false;
  return timingSafeEqual(presented, expected);
}

// ============================================================================
// User-facing Routes — /v1/writemode/{status,activate,deactivate}
// ============================================================================
// Diese Routes sind Bearer-gated (Session-JWT) und persistieren ueber die
// `write_mode`-Tabelle (Migration 0013). Sie sind unabhaengig vom HMAC-Smoke-
// Pfad — beide leben nebeneinander.
//
// Plan-Ref: docs/plans/active/PLAN-writemode.md (Slice 4/6).
// ============================================================================

const ActivateBodySchema = z
  .object({
    duration: z.union([z.literal(15), z.literal(60), z.literal(240)]),
    ts: z.number().int().positive(),
    credentialIdB64: z.string().min(1).max(512),
    authenticatorDataB64: z.string().min(1).max(4096),
    clientDataJsonB64: z.string().min(1).max(4096),
    signatureB64: z.string().min(1).max(4096),
    userHandleB64: z.string().max(512).optional(),
  })
  .strict();

export interface WritemodeUserRouteDeps {
  readonly server: ServerContext;
  readonly writemode: WritemodeService;
  /**
   * Verifier-callback. In Production via
   * `createWritemodeActivationVerifier({ db })` aus app-factory.ts. In Tests
   * kann ein No-op injiziert werden.
   */
  readonly verifyActivation: (args: VerifyWritemodeActivationArgs) => Promise<void>;
  /** Test-Helper: deterministische Uhrzeit. */
  readonly now?: () => number;
}

/**
 * Kanonikalisiert einen JSON-Wert nach RFC-8785-Style (sorted-keys, no-
 * whitespace, strict JSON-strings). Byte-identisch zur v1-PWA-Implementierung
 * in `assets/app/app.js:canonicalizeForSign` — wichtig damit Browser-Client +
 * Server denselben challenge sehen.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') +
    '}'
  );
}

function utf8ToBase64Url(s: string): string {
  return Buffer.from(s, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function writemodeUserRoutes(
  deps: WritemodeUserRouteDeps,
): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const guard = auth(deps.server);
  const now = deps.now ?? (() => Date.now());

  // GET /v1/writemode/status — eigene Sessions des angemeldeten Users.
  app.get('/v1/writemode/status', guard, async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const sessions = await deps.writemode.listActive({
      userId: principal.userId,
      now: now(),
    });
    return c.json({
      active: sessions.length > 0,
      sessions: sessions.map((s) => ({
        id: s.id,
        activated_at: s.activatedAt,
        expires_at: s.expiresAt,
      })),
    });
  });

  // POST /v1/writemode/activate — Body wie oben; verlangt WebAuthn-Signature.
  app.post('/v1/writemode/activate', guard, async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();

    let body: z.infer<typeof ActivateBodySchema>;
    try {
      const raw = await c.req.json();
      body = ActivateBodySchema.parse(raw);
    } catch (err) {
      throw HttpError.badRequest('invalid_request', 'invalid body', {
        cause: err instanceof Error ? err.message : 'parse error',
      });
    }

    const nowMs = now();
    if (Math.abs(nowMs - body.ts) > ACTIVATE_TS_SKEW_MS) {
      throw HttpError.badRequest('invalid_request', 'stale_timestamp', {
        reason: 'stale_timestamp',
        skew_ms: Math.abs(nowMs - body.ts),
        max_skew_ms: ACTIVATE_TS_SKEW_MS,
      });
    }

    const duration = body.duration as WritemodeDuration;
    if (!VALID_DURATIONS.includes(duration)) {
      throw HttpError.badRequest('invalid_request', 'invalid_duration', {
        reason: 'invalid_duration',
        allowed: VALID_DURATIONS,
      });
    }

    // Challenge byte-identisch zur Client-Seite bauen
    // ({action, duration, ts} → sorted-keys-canonical → utf8 → b64url).
    const challengePayload = {
      action: 'writemode.activate',
      duration: body.duration,
      ts: body.ts,
    };
    const expectedChallenge = utf8ToBase64Url(canonicalize(challengePayload));
    const origin = resolveOrigin(c.req.raw, deps.server.config);
    const rpId = resolveRpId(origin);

    try {
      await deps.verifyActivation({
        userId: principal.userId,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRpId: rpId,
        assertion: {
          credentialIdB64: body.credentialIdB64,
          authenticatorDataB64: body.authenticatorDataB64,
          clientDataJsonB64: body.clientDataJsonB64,
          signatureB64: body.signatureB64,
          ...(body.userHandleB64 ? { userHandleB64: body.userHandleB64 } : {}),
        },
      });
    } catch (err) {
      await emitAudit(deps.server.db, {
        action: 'writemode.activate',
        actorUserId: principal.userId,
        result: 'failure',
        ...(c.get('requestId') ? { requestId: c.get('requestId')! } : {}),
        details: {
          reason: err instanceof Error ? err.message : 'unknown',
          duration: body.duration,
        },
      }).catch(() => {
        /* audit failure is non-fatal */
      });
      throw err;
    }

    const session = await deps.writemode.activate({
      userId: principal.userId,
      durationMin: duration,
      credentialId: body.credentialIdB64,
      method: 'webauthn',
      now: nowMs,
    });

    await emitAudit(deps.server.db, {
      action: 'writemode.activate',
      actorUserId: principal.userId,
      result: 'success',
      ...(c.get('requestId') ? { requestId: c.get('requestId')! } : {}),
      details: {
        session_id: session.id,
        duration: body.duration,
        expires_at: session.expiresAt,
      },
    }).catch(() => {});

    return c.json({
      ok: true,
      session: {
        id: session.id,
        activated_at: session.activatedAt,
        expires_at: session.expiresAt,
      },
    });
  });

  // POST /v1/writemode/deactivate — Bearer-only, kein WebAuthn (safe action).
  app.post('/v1/writemode/deactivate', guard, async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const ended = await deps.writemode.deactivate({
      userId: principal.userId,
      now: now(),
    });
    await emitAudit(deps.server.db, {
      action: 'writemode.deactivate',
      actorUserId: principal.userId,
      result: 'success',
      ...(c.get('requestId') ? { requestId: c.get('requestId')! } : {}),
      details: { ended_count: ended },
    }).catch(() => {});
    return c.json({ ok: true, ended });
  });

  return app;
}

// ============================================================================
// HMAC-Smoke-Routes — unchanged below
// ============================================================================

export function writemodeRoutes(deps: WritemodeRouteDeps = {}): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const now = deps.now ?? (() => Date.now());
  const state: WritemodeState = deps.state ?? { activeUntil: 0, activatedAt: 0 };

  app.post('/writemode/start', async (c) => {
    if (!deps.smokeTestKey) {
      // 404 (statt 503), damit die Existenz des Endpoints nicht geleaked wird.
      return c.notFound();
    }
    let body: z.infer<typeof StartBodySchema>;
    try {
      const raw = await c.req.json();
      body = StartBodySchema.parse(raw);
    } catch {
      return jsonError('invalid_request');
    }

    const ts = now();
    const expiresAt = body.expires_at;
    if (expiresAt <= ts) {
      return new Response(JSON.stringify({ error: 'expired_window' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (expiresAt - ts > MAX_WINDOW_MS) {
      return new Response(
        JSON.stringify({ error: 'window_too_long', max_ms: MAX_WINDOW_MS }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }

    if (!verifyHmac(deps.smokeTestKey, String(expiresAt), body.hmac_sig)) {
      return new Response(JSON.stringify({ error: 'invalid_signature' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }

    state.activeUntil = expiresAt;
    state.activatedAt = ts;
    return c.json({ ok: true, active_until: expiresAt, activated_at: ts });
  });

  app.post('/writemode/stop', async (c) => {
    if (!deps.smokeTestKey) return c.notFound();
    let body: z.infer<typeof StopBodySchema>;
    try {
      const raw = await c.req.json();
      body = StopBodySchema.parse(raw);
    } catch {
      return jsonError('invalid_request');
    }
    if (!verifyHmac(deps.smokeTestKey, 'stop', body.hmac_sig)) {
      return new Response(JSON.stringify({ error: 'invalid_signature' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    const wasActive = state.activeUntil > now();
    state.activeUntil = 0;
    state.activatedAt = 0;
    return c.json({ ok: true, was_active: wasActive });
  });

  return app;
}
