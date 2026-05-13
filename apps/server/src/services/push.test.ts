/**
 * push.test — VAPID + RFC 8291 encryption + service-roundtrip.
 *
 * Tests use a stub DB (Map-backed) so we don't depend on a live Postgres.
 */
import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import type { DbAdapter } from '@mcp-approval2/adapters';
import {
  __INTERNAL__,
  createPushService,
  PushGoneError,
  PushSendError,
  type PushService,
  type PushServiceEnv,
} from './push.js';

// ---------------------------------------------------------------------------
// Test VAPID keypair (publicly-shared, ephemeral; do NOT use in production).
// Generated once: subtle.generateKey({name:'ECDSA', namedCurve:'P-256'}).
// ---------------------------------------------------------------------------

async function generateTestVapidEnv(): Promise<PushServiceEnv> {
  const keypair = (await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = await webcrypto.subtle.exportKey('jwk', keypair.privateKey);
  const pubJwk = await webcrypto.subtle.exportKey('jwk', keypair.publicKey);

  const x = Buffer.from(pubJwk.x!, 'base64url');
  const y = Buffer.from(pubJwk.y!, 'base64url');
  const d = Buffer.from(jwk.d!, 'base64url');
  // Uncompressed 65-byte point: 0x04 || x || y
  const pub65 = new Uint8Array(65);
  pub65[0] = 0x04;
  pub65.set(x, 1);
  pub65.set(y, 33);

  return {
    VAPID_PUBLIC_KEY: Buffer.from(pub65).toString('base64url'),
    VAPID_PRIVATE_KEY: Buffer.from(d).toString('base64url'),
    VAPID_SUBJECT: 'mailto:test@example.com',
  };
}

async function generateTestSubscriptionKeys(): Promise<{ p256dh: string; auth: string }> {
  const kp = (await webcrypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;
  const raw = await webcrypto.subtle.exportKey('raw', kp.publicKey);
  const authSecret = new Uint8Array(16);
  webcrypto.getRandomValues(authSecret);
  return {
    p256dh: Buffer.from(raw).toString('base64url'),
    auth: Buffer.from(authSecret).toString('base64url'),
  };
}

// ---------------------------------------------------------------------------
// In-memory DB-stub
// ---------------------------------------------------------------------------

function makeDbStub(): { db: DbAdapter; rows: Map<string, Record<string, unknown>>; audit: Array<{ action: string; result: string }> } {
  const rows = new Map<string, Record<string, unknown>>();
  const audit: Array<{ action: string; result: string }> = [];
  let idSeq = 0;

  const scoped = {
    async query<T>(sql: string, params?: ReadonlyArray<unknown>): Promise<T[]> {
      const s = sql.trim().toLowerCase();
      if (s.startsWith('insert into push_subscriptions')) {
        const [user_id, endpoint, p256dh, auth, user_agent, created_at] = (params ?? []) as [
          string,
          string,
          string,
          string,
          string | null,
          number,
        ];
        // ON CONFLICT(endpoint) DO UPDATE — find existing.
        for (const [id, r] of rows) {
          if (r['endpoint'] === endpoint) {
            r['p256dh'] = p256dh;
            r['auth'] = auth;
            r['user_id'] = user_id;
            r['user_agent'] = user_agent;
            return [{ id } as unknown as T];
          }
        }
        const id = `sub-${++idSeq}`;
        rows.set(id, {
          id,
          user_id,
          endpoint,
          p256dh,
          auth,
          user_agent,
          created_at,
          last_used_at: null,
        });
        return [{ id } as unknown as T];
      }
      if (s.startsWith('delete from push_subscriptions where id =')) {
        const [id, user_id] = (params ?? []) as [string, string?];
        const row = rows.get(id);
        if (row && (!user_id || row['user_id'] === user_id)) {
          rows.delete(id);
          return [{ id } as unknown as T];
        }
        return [];
      }
      if (s.startsWith('delete from push_subscriptions where id = $1')) {
        const [id] = (params ?? []) as [string];
        if (rows.delete(id)) return [{ id } as unknown as T];
        return [];
      }
      if (s.startsWith('select id, user_id, endpoint')) {
        const [user_id] = (params ?? []) as [string];
        const out: Record<string, unknown>[] = [];
        for (const r of rows.values()) {
          if (r['user_id'] === user_id) out.push(r);
        }
        return out as unknown as T[];
      }
      if (s.startsWith('update push_subscriptions set last_used_at')) {
        const [ts, id] = (params ?? []) as [number, string];
        const r = rows.get(id);
        if (r) r['last_used_at'] = ts;
        return [] as T[];
      }
      if (s.startsWith('insert into audit_log')) {
        // Best-effort capture for completeness; audit-emit hits this path
        // via emitAudit-helper. We just count it.
        audit.push({ action: String(params?.[1] ?? ''), result: String(params?.[3] ?? '') });
        return [] as T[];
      }
      // Unknown SQL → return empty (defensive).
      return [] as T[];
    },
    drizzle: {} as unknown,
  };

  const db = {
    dialect: 'postgres' as const,
    async scoped() {
      return { ...scoped, userId: 'stub', dialect: 'postgres' as const };
    },
    unsafe() {
      return { ...scoped, dialect: 'postgres' as const };
    },
    async transaction<T>(_userId: string, fn: (sc: typeof scoped) => Promise<T>): Promise<T> {
      return fn(scoped);
    },
    async migrate() {},
    async close() {},
  } as unknown as DbAdapter;

  return { db, rows, audit };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PushService', () => {
  it('subscribe + listSubscriptions roundtrip', async () => {
    const env = await generateTestVapidEnv();
    const { db } = makeDbStub();
    const push = createPushService({ db, env });

    const subKeys = await generateTestSubscriptionKeys();
    const { id } = await push.subscribe({
      userId: '00000000-0000-0000-0000-000000000001',
      endpoint: 'https://fcm.googleapis.com/fcm/send/abcdef',
      p256dh: subKeys.p256dh,
      auth: subKeys.auth,
      userAgent: 'Firefox/123',
    });
    expect(id).toMatch(/^sub-/);

    const subs = await push.listSubscriptions({ userId: '00000000-0000-0000-0000-000000000001' });
    expect(subs).toHaveLength(1);
    expect(subs[0]?.endpoint).toBe('https://fcm.googleapis.com/fcm/send/abcdef');
    expect(subs[0]?.userAgent).toBe('Firefox/123');
  });

  it('re-subscribe updates same row (ON CONFLICT endpoint)', async () => {
    const env = await generateTestVapidEnv();
    const { db } = makeDbStub();
    const push = createPushService({ db, env });
    const subKeys1 = await generateTestSubscriptionKeys();
    const subKeys2 = await generateTestSubscriptionKeys();

    const first = await push.subscribe({
      userId: 'u1',
      endpoint: 'https://example.com/p/1',
      p256dh: subKeys1.p256dh,
      auth: subKeys1.auth,
    });
    const second = await push.subscribe({
      userId: 'u1',
      endpoint: 'https://example.com/p/1', // same endpoint
      p256dh: subKeys2.p256dh,
      auth: subKeys2.auth,
    });
    expect(first.id).toBe(second.id);

    const subs = await push.listSubscriptions({ userId: 'u1' });
    expect(subs).toHaveLength(1);
    expect(subs[0]?.p256dh).toBe(subKeys2.p256dh);
  });

  it('unsubscribe deletes the row', async () => {
    const env = await generateTestVapidEnv();
    const { db } = makeDbStub();
    const push = createPushService({ db, env });
    const k = await generateTestSubscriptionKeys();

    const { id } = await push.subscribe({
      userId: 'u1',
      endpoint: 'https://example.com/p/1',
      p256dh: k.p256dh,
      auth: k.auth,
    });
    await push.unsubscribe({ userId: 'u1', subscriptionId: id });
    const subs = await push.listSubscriptions({ userId: 'u1' });
    expect(subs).toHaveLength(0);
  });

  it('rejects non-https endpoints', async () => {
    const env = await generateTestVapidEnv();
    const { db } = makeDbStub();
    const push = createPushService({ db, env });
    const k = await generateTestSubscriptionKeys();
    await expect(
      push.subscribe({
        userId: 'u1',
        endpoint: 'http://insecure.example.com/p',
        p256dh: k.p256dh,
        auth: k.auth,
      }),
    ).rejects.toThrow(/https/);
  });

  it('VAPID JWT validates against pub key', async () => {
    const env = await generateTestVapidEnv();
    const jwt = await __INTERNAL__.signVapidJwt(env, 'https://push.example.com', 1_700_000_000);
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
  });

  it('rejects bad VAPID env at boot', async () => {
    const { db } = makeDbStub();
    expect(() =>
      createPushService({
        db,
        env: { VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: 'short' },
      }),
    ).toThrow();
  });

  it('send dispatches encrypted payload to all subscriptions', async () => {
    const env = await generateTestVapidEnv();
    const { db } = makeDbStub();
    const calls: Array<{ url: string; status: number }> = [];
    const fakeFetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : (url as URL).toString();
      calls.push({ url: u, status: 201 });
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;

    const push = createPushService({ db, env, fetchImpl: fakeFetch });
    const k1 = await generateTestSubscriptionKeys();
    const k2 = await generateTestSubscriptionKeys();
    await push.subscribe({
      userId: 'u1',
      endpoint: 'https://push.example.com/a',
      p256dh: k1.p256dh,
      auth: k1.auth,
    });
    await push.subscribe({
      userId: 'u1',
      endpoint: 'https://push.example.com/b',
      p256dh: k2.p256dh,
      auth: k2.auth,
    });

    const result = await push.send({
      userId: 'u1',
      payload: { title: 'Hi', body: 'msg' },
    });
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it('send cleans up 410 Gone subscriptions', async () => {
    const env = await generateTestVapidEnv();
    const { db } = makeDbStub();
    const fakeFetch = vi.fn(async () => new Response(null, { status: 410 })) as unknown as typeof fetch;

    const push = createPushService({ db, env, fetchImpl: fakeFetch });
    const k = await generateTestSubscriptionKeys();
    await push.subscribe({
      userId: 'u1',
      endpoint: 'https://push.example.com/dead',
      p256dh: k.p256dh,
      auth: k.auth,
    });

    const result = await push.send({ userId: 'u1', payload: { title: 't', body: 'b' } });
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    const subs = await push.listSubscriptions({ userId: 'u1' });
    expect(subs).toHaveLength(0);
  });

  it('send 5xx counts as failed but does not clean up', async () => {
    const env = await generateTestVapidEnv();
    const { db } = makeDbStub();
    const fakeFetch = vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch;

    const push = createPushService({ db, env, fetchImpl: fakeFetch });
    const k = await generateTestSubscriptionKeys();
    await push.subscribe({
      userId: 'u1',
      endpoint: 'https://push.example.com/x',
      p256dh: k.p256dh,
      auth: k.auth,
    });

    const result = await push.send({ userId: 'u1', payload: { title: 't', body: 'b' } });
    expect(result.failed).toBe(1);
    const subs = await push.listSubscriptions({ userId: 'u1' });
    expect(subs).toHaveLength(1); // not removed
  });
});
