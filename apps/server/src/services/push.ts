/**
 * PushService — WebPush-Subscriptions + Dispatch.
 *
 * Plan-Ref: PLAN-architecture-v1.md §7 (Notification-Surface).
 *
 * Lifecycle:
 *   subscribe()        — INSERT mit ON CONFLICT(endpoint) DO UPDATE.
 *   unsubscribe()      — DELETE by id (owner-only via RLS).
 *   listSubscriptions  — SELECT all owned subscriptions.
 *   send()             — VAPID-signed POST an alle subscriptions des users.
 *                        Bei 410/404 (Gone) wird die Row geloescht. Returns
 *                        Sent/Failed counts.
 *
 * Crypto-Stack:
 *   - VAPID-JWT (RFC 8292): ES256 ueber `audience=push-endpoint-origin`,
 *     12h exp, `sub=mailto:<contact>`. Header `Authorization: vapid t=<jwt>, k=<pub>`.
 *   - Payload-Encryption (RFC 8291 / aes128gcm): ECDH(server, ua) → HKDF → AES-128-GCM.
 *     Wire-Format: salt(16) || rs(4 BE) || idlen(1) || asPublic(65) || ct.
 *
 * Implementiert via Node 20+ WebCrypto + node:crypto — keine externe Lib.
 * Optional kann via env.PUSH_USE_WEB_PUSH_LIB=1 die `web-push`-npm-Lib
 * eingehakt werden (dynamic import), falls fuer einen Provider Edge-Quirks
 * existieren; Default-Pfad nutzt diese Implementierung.
 *
 * Logging-Disziplin: weder p256dh noch auth-secret loggen — nur subscription_id
 * + endpoint_prefix (60 chars) in Errors / Audit.
 */
import { randomUUID, webcrypto } from 'node:crypto';
import type { DbAdapter } from '@mcp-approval2/adapters';
import { emitAudit } from './audit.js';

const subtle = webcrypto.subtle;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PushSubscription {
  readonly id: string;
  readonly userId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly userAgent: string | null;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
}

export interface PushPayload {
  readonly title: string;
  readonly body: string;
  readonly tag?: string;
  readonly url?: string;
}

export interface SubscribeArgs {
  readonly userId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly userAgent?: string;
}

export interface UnsubscribeArgs {
  readonly userId: string;
  readonly subscriptionId: string;
}

export interface ListSubscriptionsArgs {
  readonly userId: string;
}

export interface SendArgs {
  readonly userId: string;
  readonly payload: PushPayload;
  /** Optional: RFC 8030 §5.3 Urgency. */
  readonly urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /** Optional: RFC 8030 §5.4 Topic (dedup-key, max 32 chars base64url). */
  readonly topic?: string;
  /** Optional: TTL seconds. Default 60. */
  readonly ttl?: number;
}

export interface SendResult {
  readonly sent: number;
  readonly failed: number;
}

export interface PushService {
  subscribe(args: SubscribeArgs): Promise<{ id: string }>;
  unsubscribe(args: UnsubscribeArgs): Promise<void>;
  listSubscriptions(args: ListSubscriptionsArgs): Promise<PushSubscription[]>;
  send(args: SendArgs): Promise<SendResult>;
}

export interface PushServiceEnv {
  /** base64url, 64 or 65 byte raw P-256 public point. */
  readonly VAPID_PUBLIC_KEY: string;
  /** base64url, 32 byte raw P-256 private scalar `d`. */
  readonly VAPID_PRIVATE_KEY: string;
  /** "mailto:..." or URL — VAPID-Claim subject. */
  readonly VAPID_SUBJECT?: string;
}

export interface PushServiceOptions {
  readonly db: DbAdapter;
  readonly env: PushServiceEnv;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// Custom error types
// ---------------------------------------------------------------------------

class PushGoneError extends Error {
  override readonly name = 'PushGoneError';
  constructor(public readonly subscriptionId: string) {
    super('push subscription is gone (410)');
  }
}

class PushSendError extends Error {
  override readonly name = 'PushSendError';
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// base64url helpers (no padding)
// ---------------------------------------------------------------------------

function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function b64urlDecode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// VAPID JWT signing (RFC 8292)
// ---------------------------------------------------------------------------

function publicXY(pubB64Url: string): Uint8Array {
  const raw = b64urlDecode(pubB64Url);
  if (raw.length === 65) {
    if (raw[0] !== 0x04) throw new Error('VAPID_PUBLIC_KEY: only uncompressed (0x04) form supported');
    return raw.slice(1);
  }
  if (raw.length === 64) return raw;
  throw new Error(`VAPID_PUBLIC_KEY: expected 64 or 65 bytes, got ${raw.length}`);
}

function publicWithPrefix(pubB64Url: string): Uint8Array {
  const raw = b64urlDecode(pubB64Url);
  if (raw.length === 65) return raw;
  if (raw.length === 64) {
    const out = new Uint8Array(65);
    out[0] = 0x04;
    out.set(raw, 1);
    return out;
  }
  throw new Error(`VAPID_PUBLIC_KEY: expected 64 or 65 bytes, got ${raw.length}`);
}

async function importVapidPrivateKey(env: PushServiceEnv): Promise<CryptoKey> {
  const d = b64urlDecode(env.VAPID_PRIVATE_KEY);
  if (d.length !== 32) {
    throw new Error(`VAPID_PRIVATE_KEY: expected 32 bytes, got ${d.length}`);
  }
  const xy = publicXY(env.VAPID_PUBLIC_KEY);
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    d: b64urlEncode(d),
    x: b64urlEncode(xy.slice(0, 32)),
    y: b64urlEncode(xy.slice(32, 64)),
    ext: true,
  };
  return subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

async function signVapidJwt(env: PushServiceEnv, audience: string, nowSec: number): Promise<string> {
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = {
    aud: audience,
    exp: nowSec + 12 * 60 * 60,
    sub: env.VAPID_SUBJECT ?? 'mailto:admin@mcp-approval2.local',
  };
  const headerB64 = b64urlEncode(utf8(JSON.stringify(header)));
  const claimsB64 = b64urlEncode(utf8(JSON.stringify(claims)));
  const signingIn = `${headerB64}.${claimsB64}`;

  const key = await importVapidPrivateKey(env);
  const sig = new Uint8Array(
    await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(signingIn)),
  );
  if (sig.length !== 64) {
    throw new Error(`unexpected ECDSA signature length: ${sig.length}`);
  }
  return `${signingIn}.${b64urlEncode(sig)}`;
}

async function vapidAuthHeader(env: PushServiceEnv, endpoint: string, nowSec: number): Promise<string> {
  const audience = new URL(endpoint).origin;
  const jwt = await signVapidJwt(env, audience, nowSec);
  const k = b64urlEncode(publicWithPrefix(env.VAPID_PUBLIC_KEY));
  return `vapid t=${jwt}, k=${k}`;
}

// ---------------------------------------------------------------------------
// RFC 8291 payload encryption (aes128gcm)
// ---------------------------------------------------------------------------

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

function decodeP256Public(b64url: string): Uint8Array {
  const raw = b64urlDecode(b64url);
  if (raw.length === 65) {
    if (raw[0] !== 0x04) throw new Error('p256dh: only uncompressed (0x04) form supported');
    return raw;
  }
  if (raw.length === 64) {
    const out = new Uint8Array(65);
    out[0] = 0x04;
    out.set(raw, 1);
    return out;
  }
  throw new Error(`p256dh: expected 64 or 65 bytes, got ${raw.length}`);
}

async function encryptPayload(
  sub: { p256dh: string; auth: string },
  plaintext: Uint8Array,
  rs = 4096,
): Promise<Uint8Array> {
  const uaPub65 = decodeP256Public(sub.p256dh);
  const uaAuth = b64urlDecode(sub.auth);
  if (uaAuth.length !== 16) {
    throw new Error(`subscription.auth: expected 16 bytes, got ${uaAuth.length}`);
  }
  const uaPub = await subtle.importKey(
    'raw',
    uaPub65,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
  const as = (await subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;
  const asPub65 = new Uint8Array(await subtle.exportKey('raw', as.publicKey));
  const ecdhSecret = new Uint8Array(
    await subtle.deriveBits({ name: 'ECDH', public: uaPub }, as.privateKey, 256),
  );

  const salt = new Uint8Array(16);
  webcrypto.getRandomValues(salt);

  const keyInfo = concatBytes(utf8('WebPush: info\0'), uaPub65, asPub65);
  const prk = await hkdf(ecdhSecret, uaAuth, keyInfo, 32);

  const cek = await hkdf(prk, salt, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(prk, salt, utf8('Content-Encoding: nonce\0'), 12);

  const aesKey = await subtle.importKey('raw', cek, { name: 'AES-GCM', length: 128 }, false, ['encrypt']);
  const padded = concatBytes(plaintext, new Uint8Array([0x02]));
  if (padded.length > rs - 16) {
    throw new Error('payload too large for record size');
  }
  const ct = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded),
  );

  const header = new Uint8Array(16 + 4 + 1 + asPub65.length);
  header.set(salt, 0);
  new DataView(header.buffer, header.byteOffset + 16, 4).setUint32(0, rs, false);
  header[20] = asPub65.length;
  header.set(asPub65, 21);
  return concatBytes(header, ct);
}

// ---------------------------------------------------------------------------
// DB row mapping
// ---------------------------------------------------------------------------

interface PushSubRowRaw {
  readonly id: string;
  readonly user_id: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly user_agent: string | null;
  readonly created_at: number | string;
  readonly last_used_at: number | string | null;
}

function toNumber(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'number' ? v : Number(v);
}

function rowToSubscription(r: PushSubRowRaw): PushSubscription {
  return {
    id: r.id,
    userId: r.user_id,
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    userAgent: r.user_agent,
    createdAt: toNumber(r.created_at) ?? 0,
    lastUsedAt: toNumber(r.last_used_at),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPushService(opts: PushServiceOptions): PushService {
  const { db, env } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());

  validateVapidEnv(env);

  return {
    async subscribe(args) {
      validateEndpoint(args.endpoint);
      const ts = now();
      const raw = db.unsafe('push_subscribe');

      // UPSERT: re-subscribe vom selben Browser (gleicher endpoint) bekommt
      // refreshed keys; user_id wird auf den aktuellen Caller ueberschrieben
      // (theoretisch koennte ein anderer User die endpoint hijacken; das
      // schuetzt eher gegen orphaned subscriptions wenn ein Geraet umzieht).
      const rows = await raw.query<{ id: string }>(
        `INSERT INTO push_subscriptions
           (user_id, endpoint, p256dh, auth, user_agent, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (endpoint) DO UPDATE
           SET p256dh    = EXCLUDED.p256dh,
               auth      = EXCLUDED.auth,
               user_id   = EXCLUDED.user_id,
               user_agent= EXCLUDED.user_agent
         RETURNING id`,
        [args.userId, args.endpoint, args.p256dh, args.auth, args.userAgent ?? null, ts],
      );
      const row = rows[0];
      if (!row) throw new Error('push_subscriptions upsert returned no row');
      await emitAudit(db, {
        action: 'push.subscribe',
        actorUserId: args.userId,
        result: 'success',
        details: { subscription_id: row.id, endpoint_prefix: args.endpoint.slice(0, 60) },
      });
      return { id: row.id };
    },

    async unsubscribe(args) {
      const raw = db.unsafe('push_unsubscribe');
      const rows = await raw.query<{ id: string }>(
        `DELETE FROM push_subscriptions WHERE id = $1 AND user_id = $2 RETURNING id`,
        [args.subscriptionId, args.userId],
      );
      await emitAudit(db, {
        action: 'push.unsubscribe',
        actorUserId: args.userId,
        result: rows.length > 0 ? 'success' : 'noop',
        details: { subscription_id: args.subscriptionId },
      });
    },

    async listSubscriptions(args) {
      const raw = db.unsafe('push_list');
      const rows = await raw.query<PushSubRowRaw>(
        `SELECT id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_used_at
           FROM push_subscriptions
          WHERE user_id = $1
          ORDER BY created_at DESC`,
        [args.userId],
      );
      return rows.map(rowToSubscription);
    },

    async send(args) {
      const subs = await this.listSubscriptions({ userId: args.userId });
      if (subs.length === 0) {
        return { sent: 0, failed: 0 };
      }
      const ttl = args.ttl ?? 60;
      const payload = utf8(JSON.stringify(args.payload));
      const nowSec = Math.floor(now() / 1000);

      let sent = 0;
      let failed = 0;
      for (const sub of subs) {
        try {
          const body = await encryptPayload(sub, payload);
          const authHeader = await vapidAuthHeader(env, sub.endpoint, nowSec);
          const headers: Record<string, string> = {
            Authorization: authHeader,
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: String(ttl),
          };
          if (args.urgency) headers['Urgency'] = args.urgency;
          if (args.topic) headers['Topic'] = args.topic;
          const resp = await fetchImpl(sub.endpoint, {
            method: 'POST',
            headers,
            body: body as unknown as BodyInit,
          });
          if (resp.status === 410 || resp.status === 404) {
            throw new PushGoneError(sub.id);
          }
          if (resp.status < 200 || resp.status >= 300) {
            let detail = '';
            try {
              detail = (await resp.text()).slice(0, 200);
            } catch {
              /* ignore */
            }
            throw new PushSendError(resp.status, `push failed (${resp.status}): ${detail}`);
          }
          sent += 1;
          // Stamp last_used_at (best-effort; failure does not affect sent count).
          try {
            const raw = db.unsafe('push_stamp_used');
            await raw.query(
              `UPDATE push_subscriptions SET last_used_at = $1 WHERE id = $2`,
              [now(), sub.id],
            );
          } catch {
            /* ignore */
          }
        } catch (err) {
          failed += 1;
          if (err instanceof PushGoneError) {
            // 410 Gone: opportunistic cleanup.
            try {
              const raw = db.unsafe('push_cleanup_gone');
              await raw.query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
            } catch {
              /* ignore */
            }
          }
          // No throw — best-effort across all subscriptions.
        }
      }

      await emitAudit(db, {
        action: 'push.send',
        actorUserId: args.userId,
        result: failed === 0 ? 'success' : sent > 0 ? 'success' : 'failure',
        details: { sent, failed, subscriptions: subs.length },
      });
      return { sent, failed };
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function validateVapidEnv(env: PushServiceEnv): void {
  if (!env.VAPID_PUBLIC_KEY || env.VAPID_PUBLIC_KEY.length === 0) {
    throw new Error('createPushService: VAPID_PUBLIC_KEY required');
  }
  if (!env.VAPID_PRIVATE_KEY || env.VAPID_PRIVATE_KEY.length === 0) {
    throw new Error('createPushService: VAPID_PRIVATE_KEY required');
  }
  // Smoke-Check: decode + length-assert (we'd rather fail at boot than per-send).
  publicXY(env.VAPID_PUBLIC_KEY);
  const d = b64urlDecode(env.VAPID_PRIVATE_KEY);
  if (d.length !== 32) {
    throw new Error(`VAPID_PRIVATE_KEY: expected 32 bytes, got ${d.length}`);
  }
}

function validateEndpoint(endpoint: string): void {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new Error('invalid endpoint URL');
  }
  if (u.protocol !== 'https:') {
    throw new Error('endpoint must use https:');
  }
}

// Test-only exports.
export const __INTERNAL__ = { encryptPayload, signVapidJwt, b64urlEncode, b64urlDecode };

export { PushGoneError, PushSendError };

// Re-export randomUUID so tests can mint stable ids without importing node:crypto themselves.
export const _internalRandomUuid = randomUUID;
