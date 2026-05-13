/**
 * Integration-Test fuer `createApp` (app-factory.ts).
 *
 * Ziel: alle Module sind richtig gemountet + 401-Behavior ist konsistent ueber
 * Bearer-geschuetzte Routen. Das ist kein End-to-End-Tool-Dispatch-Test —
 * dafuer gibt's separate Test-Files in routes/* + services/*.
 *
 * Wir injizieren einen Stub-DbAdapter (keine echte Postgres), und prufen das
 * Routing-Verhalten — Routes existieren, Auth-Gate funktioniert, /health
 * antwortet immer 200.
 */
import { describe, it, expect, vi } from 'vitest';
import { createApp } from './app-factory.js';
import type { ServerContext } from './lib/context.js';
import type { AppConfig } from './lib/config.js';
import type { ApprovalService } from './services/approvals.js';
import type { CostTracker } from './services/cost-tracker.js';

// ---------------------------------------------------------------------------
// Stub-Builders
// ---------------------------------------------------------------------------

function makeStubDb(): ServerContext['db'] {
  const scoped = {
    userId: 'test-user',
    dialect: 'postgres' as const,
    drizzle: {},
    async query<T>(): Promise<T[]> {
      return [];
    },
  };

  const raw = {
    dialect: 'postgres' as const,
    drizzle: {},
    async query<T>(): Promise<T[]> {
      return [];
    },
  };

  return {
    dialect: 'postgres' as const,
    async scoped() {
      return scoped;
    },
    unsafe() {
      return raw;
    },
    async transaction<T>(
      _uid: string,
      fn: (tx: typeof scoped, ctx: { userId: string; dialect: 'postgres' }) => Promise<T>,
    ): Promise<T> {
      return fn(scoped, { userId: 'test', dialect: 'postgres' });
    },
    async migrate() {
      return;
    },
    async close() {
      return;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeStubConfig(): AppConfig {
  return {
    NODE_ENV: 'test',
    PORT: 0,
    ORIGIN: 'http://localhost:8787',
    DATABASE_URL: 'postgres://stub',
    DATABASE_DIALECT: 'postgres',
    JWT_SECRET: 'x'.repeat(32),
    JWT_ISSUER: 'mcp-approval2',
    JWT_AUDIENCE: 'mcp-approval2-api',
    SESSION_TTL_SEC: 1800,
    REFRESH_TTL_SEC: 30 * 24 * 60 * 60,
    GOOGLE_CLIENT_ID: 'stub-client-id',
    GOOGLE_CLIENT_SECRET: 'stub-secret',
    GOOGLE_REDIRECT_URI: 'http://localhost:8787/auth/google/callback',
    RP_ID: 'localhost',
    RP_NAME: 'mcp-approval2',
    RP_ORIGIN: 'http://localhost:8787',
    INVITE_TTL_SEC: 24 * 60 * 60,
    RECOVERY_TTL_SEC: 24 * 60 * 60,
  };
}

function makeServer(): ServerContext {
  return { config: makeStubConfig(), db: makeStubDb() };
}

// Approval-Service-Stub: returnt leere Listen, throws nicht.
function makeStubApprovals(): ApprovalService {
  return {
    create: vi.fn(async () => ({}) as never),
    get: vi.fn(async () => null),
    list: vi.fn(async () => []),
    approve: vi.fn(async () => ({}) as never),
    reject: vi.fn(async () => ({}) as never),
    sweepExpired: vi.fn(async () => 0),
    setResult: vi.fn(async () => undefined),
  };
}

// Cost-Tracker-Stub: precheck allowed=true, record no-op.
function makeStubCostTracker(): CostTracker {
  return {
    precheck: vi.fn(async () => ({
      allowed: true,
      remainingUsd: 5,
      spentUsd: 0,
      limitUsd: 5,
      softLimitReached: false,
    })),
    record: vi.fn(async () => undefined),
    getDaily: vi.fn(async () => ({ date: '2026-05-13', totalUsd: 0, calls: 0 })),
    estimateChat: vi.fn(() => 0.001),
    estimateEmbed: vi.fn(() => 0.0001),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createApp — module wiring', () => {
  it('GET /health → 200 ok (always public)', async () => {
    const app = await createApp(makeServer(), {
      approvals: makeStubApprovals(),
      costTracker: makeStubCostTracker(),
      disableRateLimit: true,
    });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('GET /v1/approvals without Bearer → 401', async () => {
    const app = await createApp(makeServer(), {
      approvals: makeStubApprovals(),
      costTracker: makeStubCostTracker(),
      disableRateLimit: true,
    });
    const res = await app.request('/v1/approvals');
    expect(res.status).toBe(401);
  });

  it('GET /v1/approvals/:id without Bearer → 401', async () => {
    const app = await createApp(makeServer(), {
      approvals: makeStubApprovals(),
      costTracker: makeStubCostTracker(),
      disableRateLimit: true,
    });
    const res = await app.request('/v1/approvals/abc');
    expect(res.status).toBe(401);
  });

  it('POST /v1/approvals/:id/approve without Bearer → 401', async () => {
    const app = await createApp(makeServer(), {
      approvals: makeStubApprovals(),
      costTracker: makeStubCostTracker(),
      disableRateLimit: true,
    });
    const res = await app.request('/v1/approvals/abc/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signatureB64: 'AAA' }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /v1/approvals/:id/reject without Bearer → 401', async () => {
    const app = await createApp(makeServer(), {
      approvals: makeStubApprovals(),
      costTracker: makeStubCostTracker(),
      disableRateLimit: true,
    });
    const res = await app.request('/v1/approvals/abc/reject', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it('POST /mcp without Bearer → 401 (auth before transport)', async () => {
    const app = await createApp(makeServer(), {
      approvals: makeStubApprovals(),
      costTracker: makeStubCostTracker(),
      disableRateLimit: true,
    });
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  it('GET /v1/admin/invites without Bearer → 401', async () => {
    const app = await createApp(makeServer(), {
      approvals: makeStubApprovals(),
      costTracker: makeStubCostTracker(),
      disableRateLimit: true,
    });
    const res = await app.request('/v1/admin/invites');
    expect(res.status).toBe(401);
  });

  it('OAuth discovery is public — GET /.well-known/oauth-authorization-server → 200', async () => {
    const app = await createApp(makeServer(), {
      approvals: makeStubApprovals(),
      costTracker: makeStubCostTracker(),
      disableRateLimit: true,
    });
    const res = await app.request('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
  });
});

describe('createApp — internal routes mounting', () => {
  it('without INTERNAL_SERVICE_TOKEN, internal routes are NOT mounted (404)', async () => {
    const app = await createApp(makeServer(), {
      approvals: makeStubApprovals(),
      costTracker: makeStubCostTracker(),
      disableRateLimit: true,
    });
    const res = await app.request('/internal/v1/sub-mcp/discover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('with INTERNAL_SERVICE_TOKEN, internal routes require service-token (401)', async () => {
    const app = await createApp(makeServer(), {
      approvals: makeStubApprovals(),
      costTracker: makeStubCostTracker(),
      disableRateLimit: true,
      internalServiceToken: 'service-secret-32-bytes-or-longer-token',
    });
    const res = await app.request('/internal/v1/sub-mcp/discover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('with valid service-token, /internal/v1/sub-mcp/discover dispatches', async () => {
    const token = 'service-secret-32-bytes-or-longer-token';
    const app = await createApp(makeServer(), {
      approvals: makeStubApprovals(),
      costTracker: makeStubCostTracker(),
      disableRateLimit: true,
      internalServiceToken: token,
    });
    const res = await app.request('/internal/v1/sub-mcp/discover', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    // 200 (empty refresh-list) erwartet, weil unser DB-Stub keine sub-MCPs liefert.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refreshed: unknown };
    expect(Array.isArray(body.refreshed)).toBe(true);
  });
});

describe('createApp — cost gate disabled when dailyLimitUsd=0', () => {
  it('POST /mcp without Bearer still 401 even with dailyLimitUsd=0', async () => {
    const app = await createApp(makeServer(), {
      approvals: makeStubApprovals(),
      costTracker: makeStubCostTracker(),
      disableRateLimit: true,
      dailyLimitUsd: 0,
    });
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    // Auth-Middleware ist im mcpTransport selbst — die rate-limit + cost-gate
    // sind disabled, aber auth bleibt drin.
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Burst-7 route-mount tests
// ---------------------------------------------------------------------------

describe('createApp — Burst-7 route mounts', () => {
  it('GET /v1/apps without Bearer → 401 (apps route mounted when knowledge present)', async () => {
    // Stub a minimal KnowledgeService so AppsService is built.
    const knowledge = {
      listObjects: vi.fn(async () => ({ items: [], cursor: null })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const app = await createApp(makeServer(), {
      approvals: makeStubApprovals(),
      costTracker: makeStubCostTracker(),
      disableRateLimit: true,
      knowledge,
    });
    const res = await app.request('/v1/apps');
    expect(res.status).toBe(401);
  });

  it('GET /v1/apps WITHOUT knowledge service → 404 (apps route not mounted)', async () => {
    const app = await createApp(makeServer(), {
      approvals: makeStubApprovals(),
      costTracker: makeStubCostTracker(),
      disableRateLimit: true,
    });
    const res = await app.request('/v1/apps');
    expect(res.status).toBe(404);
  });

  it('POST /v1/push/subscribe without Bearer → 401 (push mounted when pushEnv set)', async () => {
    const app = await createApp(makeServer(), {
      approvals: makeStubApprovals(),
      costTracker: makeStubCostTracker(),
      disableRateLimit: true,
      pushEnv: {
        VAPID_PUBLIC_KEY: 'AAA',
        VAPID_PRIVATE_KEY: 'BBB',
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      push: { subscribe: vi.fn(), unsubscribe: vi.fn(), listSubscriptions: vi.fn(), send: vi.fn() } as any,
    });
    const res = await app.request('/v1/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://push.example/x',
        keys: { p256dh: 'x', auth: 'y' },
      }),
    });
    expect(res.status).toBe(401);
  });

  it('GET /v1/push/vapid is public (200 when key set)', async () => {
    const app = await createApp(makeServer(), {
      approvals: makeStubApprovals(),
      costTracker: makeStubCostTracker(),
      disableRateLimit: true,
      pushEnv: {
        VAPID_PUBLIC_KEY: 'PUB',
        VAPID_PRIVATE_KEY: 'PRIV',
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      push: { subscribe: vi.fn(), unsubscribe: vi.fn(), listSubscriptions: vi.fn(), send: vi.fn() } as any,
    });
    const res = await app.request('/v1/push/vapid');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { publicKey: string };
    expect(body.publicKey).toBe('PUB');
  });

  it('POST /writemode/start WITHOUT SMOKE_TEST_KEY → 404 (not mounted, leak-safe)', async () => {
    const app = await createApp(makeServer(), {
      approvals: makeStubApprovals(),
      costTracker: makeStubCostTracker(),
      disableRateLimit: true,
    });
    const res = await app.request('/writemode/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expires_at: Date.now() + 60_000, hmac_sig: 'aa' }),
    });
    expect(res.status).toBe(404);
  });

  it('POST /writemode/start WITH SMOKE_TEST_KEY but invalid sig → 401', async () => {
    const app = await createApp(makeServer(), {
      approvals: makeStubApprovals(),
      costTracker: makeStubCostTracker(),
      disableRateLimit: true,
      smokeTestKey: 'pre-shared-secret-32-chars-or-more-12345',
    });
    const res = await app.request('/writemode/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expires_at: Date.now() + 60_000,
        hmac_sig: 'deadbeef',
      }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /internal/v1/cron/:task WITHOUT internal token → 404 (routes not mounted)', async () => {
    const app = await createApp(makeServer(), {
      approvals: makeStubApprovals(),
      costTracker: makeStubCostTracker(),
      disableRateLimit: true,
    });
    const res = await app.request('/internal/v1/cron/sweep-output-refs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('POST /internal/v1/cron/:task WITH internal token but no Bearer → 401', async () => {
    const token = 'service-secret-32-bytes-or-longer-token';
    const app = await createApp(makeServer(), {
      approvals: makeStubApprovals(),
      costTracker: makeStubCostTracker(),
      disableRateLimit: true,
      internalServiceToken: token,
    });
    const res = await app.request('/internal/v1/cron/sweep-output-refs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});
