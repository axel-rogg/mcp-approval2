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
import type { AppBindings } from '../lib/context.js';

const MAX_WINDOW_MS = 15 * 60 * 1000; // 15 min

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
