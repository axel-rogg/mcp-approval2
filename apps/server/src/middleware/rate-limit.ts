/**
 * Rate-Limit-Middleware.
 *
 * Plan-Ref: PLAN-architecture-v1.md §10 (Rate-Limiting) + §11.6 (Phase 6
 * Pilot-Hardening).
 *
 * Algorithmus: klassischer Token-Bucket pro Bucket-Key.
 *   - capacity Tokens insgesamt
 *   - refill_per_sec Tokens fliessen kontinuierlich nach (lazy bei consume())
 *   - tryConsume(key, n) → wenn genug Tokens vorhanden, abziehen + true.
 *     Sonst false + retryAfter berechnen.
 *
 * Zwei Buckets pro Request:
 *   user:<userId>       — pro-User-Quota (z.B. 100 req/min)
 *   tenant:global       — instance-weiter Burst-Schutz (z.B. 10k req/h)
 *
 * Beide MUESSEN gleichzeitig genug Tokens haben. Wenn einer ablehnt → 429.
 *
 * Phase-1-Storage: in-Memory-Map. Wenn nur ein Worker laeuft, gut genug.
 * Phase-2: Redis-Backend (Lua-Script-atomic) — gleicher BucketStore-Interface,
 * Replacement durch DI.
 *
 * Cost-Controls (§8.3): separater bucket-Namespace 'cost:<userId>' fuer
 * Tages-USD-Budget. Hier nicht implementiert (Schema-ready in 0004); Aufruf
 * an `buckets.tryConsume('cost:<id>', dollars * 100)` aus AI-Adapter waere
 * der Hook.
 */
import type { MiddlewareHandler } from 'hono';
import type { AppBindings } from '../lib/context.js';
import { HttpError } from '../lib/errors.js';

export interface BucketConfig {
  /** Maximale Anzahl Tokens die der Bucket halten kann. */
  readonly capacity: number;
  /** Refill-Rate in Tokens pro Sekunde (kann fractional sein). */
  readonly refillPerSec: number;
}

export interface RateLimitConfig {
  readonly perUser: BucketConfig;
  readonly perTenant: BucketConfig;
}

export interface BucketStore {
  /**
   * Versucht n Tokens aus dem bucketKey zu konsumieren.
   * Returns true wenn erfolgreich, false sonst.
   *
   * Wenn der Bucket noch nicht existiert, wird er mit `cfg` initialisiert
   * und mit voller Kapazitaet befuellt.
   */
  tryConsume(bucketKey: string, n: number, cfg: BucketConfig): Promise<TryConsumeResult>;
}

export interface TryConsumeResult {
  readonly allowed: boolean;
  /** Sekunden bis genug Tokens fuer den naechsten Consume vorhanden waeren. */
  readonly retryAfterSec: number;
  /** Aktueller Token-Count (Debug / Observability). */
  readonly remaining: number;
}

export interface RateLimitDeps {
  readonly buckets: BucketStore;
  /** Optional: clock fuer Tests. Default Date.now(). */
  readonly now?: () => number;
  /** Optional: Custom Bucket-Key-Builder. */
  readonly userBucketKey?: (userId: string) => string;
  /** Optional: Tenant-Bucket-Key. Default 'tenant:global'. */
  readonly tenantBucketKey?: string;
}

/**
 * In-Memory-Implementation des BucketStore. Single-Instance-only.
 *
 * Race-Condition-Hinweis: tryConsume ist async aber das eigentliche read-modify-
 * write laeuft synchron auf der Map. Node-Event-Loop garantiert keine echte
 * Concurrency hier. Bei Multi-Instance: durch Redis-Impl ersetzen.
 */
export class InMemoryBucketStore implements BucketStore {
  private readonly buckets = new Map<string, { tokens: number; lastRefill: number }>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  tryConsume(bucketKey: string, n: number, cfg: BucketConfig): Promise<TryConsumeResult> {
    const now = this.now();
    let state = this.buckets.get(bucketKey);
    if (!state) {
      state = { tokens: cfg.capacity, lastRefill: now };
      this.buckets.set(bucketKey, state);
    }

    // Lazy refill: berechne wieviel Zeit seit lastRefill vergangen ist und
    // adde anteilig refillPerSec * dt Tokens (gecappt auf capacity).
    const dtSec = Math.max(0, (now - state.lastRefill) / 1000);
    const refilled = Math.min(cfg.capacity, state.tokens + dtSec * cfg.refillPerSec);
    state.tokens = refilled;
    state.lastRefill = now;

    if (state.tokens >= n) {
      state.tokens -= n;
      return Promise.resolve({ allowed: true, retryAfterSec: 0, remaining: state.tokens });
    }

    // Nicht genug: berechne wie lange man warten muesste.
    const deficit = n - state.tokens;
    const retryAfterSec = cfg.refillPerSec > 0 ? Math.ceil(deficit / cfg.refillPerSec) : 60;
    return Promise.resolve({ allowed: false, retryAfterSec, remaining: state.tokens });
  }

  /** Test-only: clear all buckets. */
  reset(): void {
    this.buckets.clear();
  }

  /** Test-only: peek current state. */
  peek(bucketKey: string): { tokens: number; lastRefill: number } | undefined {
    const s = this.buckets.get(bucketKey);
    return s ? { ...s } : undefined;
  }
}

const DEFAULT_USER_BUCKET_KEY = (userId: string): string => `user:${userId}`;
const DEFAULT_TENANT_BUCKET_KEY = 'tenant:global';

export function createRateLimitMiddleware(
  config: RateLimitConfig,
  deps: RateLimitDeps,
): MiddlewareHandler<AppBindings> {
  const userBucketKey = deps.userBucketKey ?? DEFAULT_USER_BUCKET_KEY;
  const tenantBucketKey = deps.tenantBucketKey ?? DEFAULT_TENANT_BUCKET_KEY;

  return async (c, next) => {
    const user = c.get('user');
    // Unauthenticated requests (z.B. /health, /auth/*) — skip rate-limit.
    // Auth-Routen haben ggf. eigene Limits (TODO Phase 2 — separate
    // anonymous-Bucket per-IP).
    if (!user) {
      await next();
      return;
    }

    // Tenant-Bucket zuerst (Anti-Burst). Wenn instance-weit voll, ist das
    // ein "lauter Nachbar"-Problem, nicht der User. Aber die Antwort ist
    // dieselbe — 429.
    const tenantResult = await deps.buckets.tryConsume(tenantBucketKey, 1, config.perTenant);
    if (!tenantResult.allowed) {
      c.header('Retry-After', String(tenantResult.retryAfterSec));
      c.header('X-RateLimit-Scope', 'tenant');
      throw new HttpError(429, 'rate_limited', 'rate_limit_exceeded (tenant)', {
        retryAfterSec: tenantResult.retryAfterSec,
        scope: 'tenant',
      });
    }

    const userResult = await deps.buckets.tryConsume(userBucketKey(user.userId), 1, config.perUser);
    if (!userResult.allowed) {
      c.header('Retry-After', String(userResult.retryAfterSec));
      c.header('X-RateLimit-Scope', 'user');
      throw new HttpError(429, 'rate_limited', 'rate_limit_exceeded (user)', {
        retryAfterSec: userResult.retryAfterSec,
        scope: 'user',
      });
    }

    // Observability-Header (optional, hilft beim Debuggen).
    c.header('X-RateLimit-Remaining-User', String(Math.floor(userResult.remaining)));
    c.header('X-RateLimit-Remaining-Tenant', String(Math.floor(tenantResult.remaining)));

    await next();
  };
}

/**
 * Default-Config fuer Pilot:
 *   - 100 Requests pro Minute pro User  (capacity 100, refill 1.6667/s)
 *   - 10k Requests pro Stunde gesamt    (capacity 10000, refill ~2.78/s)
 *
 * Tunable via Env-Vars in spaeterer Iteration. Phase 1 sind diese Defaults
 * konservativ-grosszuegig, weil Pilot maximum 5-15 User hat.
 */
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  perUser: { capacity: 100, refillPerSec: 100 / 60 },
  perTenant: { capacity: 10_000, refillPerSec: 10_000 / 3600 },
};
