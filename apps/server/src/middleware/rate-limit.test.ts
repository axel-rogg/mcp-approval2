/**
 * Unit-Tests fuer Rate-Limit-Middleware + Token-Bucket-Store.
 *
 * Scope:
 *   - InMemoryBucketStore: refill + consume + deficit-Berechnung
 *   - createRateLimitMiddleware: user-bucket exceeded → 429
 *   - createRateLimitMiddleware: tenant-bucket exceeded → 429
 *   - Skip wenn kein user (unauthenticated request)
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { AppBindings, SessionPrincipal } from '../lib/context.js';
import { errorHandler } from './error-handler.js';
import { requestId } from './request-id.js';
import {
  InMemoryBucketStore,
  createRateLimitMiddleware,
  type RateLimitConfig,
} from './rate-limit.js';

function makeApp(
  config: RateLimitConfig,
  buckets: InMemoryBucketStore,
  principal: SessionPrincipal | null,
): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use('*', requestId());
  app.onError(errorHandler());
  app.use('*', async (c, next) => {
    if (principal) c.set('user', principal);
    await next();
  });
  app.use('*', createRateLimitMiddleware(config, { buckets }));
  app.get('/ping', (c) => c.json({ ok: true }));
  return app;
}

const USER: SessionPrincipal = {
  userId: '11111111-1111-1111-1111-111111111111',
  email: 'a@example.com',
  role: 'member',
  sessionId: '22222222-2222-2222-2222-222222222222',
  issuedAt: 0,
  expiresAt: Date.now() + 60_000,
};

describe('InMemoryBucketStore', () => {
  it('first consume succeeds (bucket starts full)', async () => {
    const store = new InMemoryBucketStore();
    const r = await store.tryConsume('user:x', 1, { capacity: 10, refillPerSec: 1 });
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(9);
  });

  it('returns false when tokens insufficient + reports retryAfterSec', async () => {
    let t = 1000;
    const store = new InMemoryBucketStore({ now: () => t });
    // Verbrauche alle 3 Tokens
    for (let i = 0; i < 3; i++) {
      const r = await store.tryConsume('user:x', 1, { capacity: 3, refillPerSec: 0.5 });
      expect(r.allowed).toBe(true);
    }
    const denied = await store.tryConsume('user:x', 1, { capacity: 3, refillPerSec: 0.5 });
    expect(denied.allowed).toBe(false);
    // 0 tokens → need 1, refill 0.5/sec → 2 sec wait
    expect(denied.retryAfterSec).toBe(2);
  });

  it('refills tokens over time', async () => {
    let t = 1000;
    const store = new InMemoryBucketStore({ now: () => t });
    await store.tryConsume('user:x', 10, { capacity: 10, refillPerSec: 1 }); // empty
    const empty = await store.tryConsume('user:x', 1, { capacity: 10, refillPerSec: 1 });
    expect(empty.allowed).toBe(false);
    // Warte 3 Sekunden simuliert
    t = 4000;
    const refilled = await store.tryConsume('user:x', 1, { capacity: 10, refillPerSec: 1 });
    expect(refilled.allowed).toBe(true);
    // 3 sec * 1 token/sec = 3 → minus 1 consumed = 2
    expect(refilled.remaining).toBeCloseTo(2, 1);
  });

  it('caps tokens at capacity (no over-fill)', async () => {
    let t = 1000;
    const store = new InMemoryBucketStore({ now: () => t });
    await store.tryConsume('user:x', 1, { capacity: 5, refillPerSec: 1 }); // 4 left
    t = 1000 + 1000 * 1000; // 1000 sec spaeter
    const r = await store.tryConsume('user:x', 1, { capacity: 5, refillPerSec: 1 });
    expect(r.allowed).toBe(true);
    // capped at 5, minus 1 → 4
    expect(r.remaining).toBe(4);
  });
});

describe('createRateLimitMiddleware', () => {
  const config: RateLimitConfig = {
    perUser: { capacity: 3, refillPerSec: 0.1 },
    perTenant: { capacity: 100, refillPerSec: 10 },
  };

  it('skip when no user (unauthenticated)', async () => {
    const buckets = new InMemoryBucketStore();
    const app = makeApp(config, buckets, null);
    for (let i = 0; i < 50; i++) {
      const res = await app.request('/ping');
      expect(res.status).toBe(200);
    }
  });

  it('allows requests up to user-capacity', async () => {
    const buckets = new InMemoryBucketStore();
    const app = makeApp(config, buckets, USER);
    for (let i = 0; i < 3; i++) {
      const res = await app.request('/ping');
      expect(res.status).toBe(200);
    }
  });

  it('user-bucket exceeded → 429 with Retry-After', async () => {
    const buckets = new InMemoryBucketStore();
    const app = makeApp(config, buckets, USER);
    // Verbrauche alle 3 Tokens
    for (let i = 0; i < 3; i++) {
      const res = await app.request('/ping');
      expect(res.status).toBe(200);
    }
    const denied = await app.request('/ping');
    expect(denied.status).toBe(429);
    expect(denied.headers.get('Retry-After')).toBeTruthy();
    expect(denied.headers.get('X-RateLimit-Scope')).toBe('user');
    const body = (await denied.json()) as { error: { code: string; details?: { scope: string } } };
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.details?.scope).toBe('user');
  });

  it('tenant-bucket exceeded → 429 even with fresh user-bucket', async () => {
    const tinyTenant: RateLimitConfig = {
      perUser: { capacity: 1000, refillPerSec: 1000 },
      perTenant: { capacity: 2, refillPerSec: 0.01 },
    };
    const buckets = new InMemoryBucketStore();
    const app = makeApp(tinyTenant, buckets, USER);
    expect((await app.request('/ping')).status).toBe(200);
    expect((await app.request('/ping')).status).toBe(200);
    const denied = await app.request('/ping');
    expect(denied.status).toBe(429);
    expect(denied.headers.get('X-RateLimit-Scope')).toBe('tenant');
  });

  it('per-user buckets are isolated', async () => {
    const buckets = new InMemoryBucketStore();
    const userA = USER;
    const userB: SessionPrincipal = { ...USER, userId: '33333333-3333-3333-3333-333333333333' };

    const appA = makeApp(config, buckets, userA);
    const appB = makeApp(config, buckets, userB);

    // Verbrauche userA komplett
    for (let i = 0; i < 3; i++) expect((await appA.request('/ping')).status).toBe(200);
    expect((await appA.request('/ping')).status).toBe(429);

    // userB ist nicht betroffen
    expect((await appB.request('/ping')).status).toBe(200);
  });
});
