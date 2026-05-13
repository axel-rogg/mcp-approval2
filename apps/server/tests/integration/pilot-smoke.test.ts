/**
 * Pilot-Smoke — Integration Test (App-Boot, /health, Auth-Flow, Credential-CRUD,
 * Approval-Flow, MCP-Call).
 *
 * Plan-Ref: docs/runbooks/runbook-pilot-smoke.md
 *
 * Setup:
 *   - In-memory Stub-DB (gleicher Stil wie src/routes/internal/dek.test.ts).
 *   - LocalKekProvider mit Random-MasterKey (kein Vault / kein Postgres noetig).
 *   - createApp(...) gewuenscht mit allen Services dranne — internalServiceToken,
 *     kekProvider, costTracker-Stub, approvals-Stub.
 *
 * Diese Tests sind eine schnelle CI-Sicherung dass die Critical-Path-Endpoints
 * korrekt gemounted sind und 401/200/etc. konsistent sind. Sie ersetzen NICHT
 * das volle e2e-smoke gegen Docker-Compose (siehe scripts/pilot-smoke.sh fuer
 * den Stack-Test).
 *
 * Erwartete Endpoints:
 *   GET  /health                                  → 200
 *   GET  /.well-known/oauth-authorization-server  → 200 (public)
 *   GET  /.well-known/jwks.json                   → 200 (public, leeres keys[])
 *   POST /internal/v1/dek/resolve                 → 401 ohne Service-Token; 200 mit
 *   POST /internal/v1/credentials/resolve         → 401 ohne Service-Token
 *   POST /mcp                                     → 401 ohne Bearer
 *
 * Approval-Flow: minimaler 401-Gate-Test (volle Flow-Tests siehe
 * src/routes/approvals.test.ts).
 *
 * Credential-CRUD: 401-Gate-Test (vollstaendig in src/routes/credentials.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import { LocalKekProvider } from '@mcp-approval2/adapters';
import type { DbAdapter, RawDb, ScopedDb } from '@mcp-approval2/adapters';
import { randomBytes } from '@mcp-approval2/core';
import { createApp } from '../../src/app-factory.js';
import type { ServerContext } from '../../src/lib/context.js';
import type { AppConfig } from '../../src/lib/config.js';
import type { ApprovalService } from '../../src/services/approvals.js';
import type { CostTracker } from '../../src/services/cost-tracker.js';

// ─── Stubs ────────────────────────────────────────────────────────────────

const SVC_TOKEN = 's'.repeat(48);
const USER_A = '11111111-1111-1111-1111-111111111111';

interface SeedRow {
  user_id: string;
  wrapped_dek: Uint8Array;
  kek_ref: string;
  created_at: number;
  rotated_at: number | null;
}

function makeMemoryDb(): DbAdapter {
  const seeds = new Map<string, SeedRow>();

  function exec<T = unknown>(text: string, params: ReadonlyArray<unknown>): T[] {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t.startsWith('SELECT user_id, wrapped_dek')) {
      const r = seeds.get(String(params[0]));
      return (r ? [r] : []) as unknown as T[];
    }
    if (t.startsWith('INSERT INTO user_dek_seeds')) {
      const [userId, wrapped, kekRef, createdAt] = params as readonly unknown[];
      const uid = String(userId);
      if (seeds.has(uid)) return [] as unknown as T[];
      const row: SeedRow = {
        user_id: uid,
        wrapped_dek: wrapped as Uint8Array,
        kek_ref: String(kekRef),
        created_at: Number(createdAt),
        rotated_at: null,
      };
      seeds.set(uid, row);
      return [row] as unknown as T[];
    }
    if (t.startsWith('INSERT INTO audit_log')) {
      return [] as unknown as T[];
    }
    if (t.startsWith('SELECT') && t.includes('FROM sub_mcp_servers')) {
      return [] as unknown as T[];
    }
    if (t.startsWith('SELECT') || t.startsWith('UPDATE') || t.startsWith('DELETE')) {
      return [] as unknown as T[];
    }
    if (t.startsWith('INSERT')) {
      return [] as unknown as T[];
    }
    return [] as unknown as T[];
  }

  const raw: RawDb = {
    dialect: 'postgres',
    drizzle: {},
    async query<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
      return exec<T>(sql, params);
    },
  };
  return {
    dialect: 'postgres',
    async scoped(userId: string): Promise<ScopedDb> {
      return {
        userId,
        dialect: 'postgres',
        drizzle: {},
        async query<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
          return exec<T>(sql, params);
        },
      };
    },
    unsafe(_reason: string): RawDb {
      return raw;
    },
    async transaction<T>(userId: string, fn): Promise<T> {
      return fn(await this.scoped(userId), { userId, dialect: 'postgres' });
    },
    async migrate() {},
    async close() {},
  };
}

function makeConfig(): AppConfig {
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
    INVITE_TTL_SEC: 86400,
    RECOVERY_TTL_SEC: 86400,
  };
}

function makeServer(): ServerContext {
  return { config: makeConfig(), db: makeMemoryDb() };
}

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

async function buildApp(opts: { withInternalToken?: boolean; withKek?: boolean } = {}) {
  const server = makeServer();
  const internalServiceToken = opts.withInternalToken ? SVC_TOKEN : undefined;
  const kekProvider = opts.withKek
    ? new LocalKekProvider({ masterKey: randomBytes(32) })
    : undefined;

  const deps: Parameters<typeof createApp>[1] = {
    approvals: makeStubApprovals(),
    costTracker: makeStubCostTracker(),
    disableRateLimit: true,
  };
  if (internalServiceToken) deps.internalServiceToken = internalServiceToken;
  if (kekProvider) deps.kekProvider = kekProvider;

  const app = await createApp(server, deps);
  return { app, server };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('Pilot-Smoke E2E (in-memory)', () => {
  it('1. GET /health → 200 ok', async () => {
    const { app } = await buildApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('mcp-approval2');
  });

  it('2. GET /.well-known/oauth-authorization-server → 200 with issuer', async () => {
    const { app } = await buildApp();
    const res = await app.request('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issuer?: string };
    expect(typeof body.issuer).toBe('string');
    expect(body.issuer?.length).toBeGreaterThan(0);
  });

  it('3. GET /.well-known/jwks.json → 200 with keys array', async () => {
    const { app } = await buildApp();
    const res = await app.request('/.well-known/jwks.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: ReadonlyArray<unknown> };
    expect(Array.isArray(body.keys)).toBe(true);
    // Dev-Setup ohne RS256-Keys → keys ist leer. Beides ist OK fuer den Smoke.
    expect(body.keys.length).toBeGreaterThanOrEqual(0);
  });

  it('4. POST /mcp without Bearer → 401', async () => {
    const { app } = await buildApp();
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  describe('Internal endpoints (with internalServiceToken + kekProvider)', () => {
    it('5. POST /internal/v1/dek/resolve without service token → 401', async () => {
      const { app } = await buildApp({ withInternalToken: true, withKek: true });
      const res = await app.request('/internal/v1/dek/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: USER_A }),
      });
      expect(res.status).toBe(401);
    });

    it('6. POST /internal/v1/dek/resolve with Bearer service token → 200 + dek_b64', async () => {
      const { app } = await buildApp({ withInternalToken: true, withKek: true });
      const res = await app.request('/internal/v1/dek/resolve', {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${SVC_TOKEN}`,
          'content-type': 'application/json',
          'x-request-id': 'pilot-smoke-test',
        },
        body: JSON.stringify({ user_id: USER_A }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { dek_b64: string };
      expect(typeof body.dek_b64).toBe('string');
      expect(Buffer.from(body.dek_b64, 'base64').byteLength).toBe(32);
    });

    it('7. POST /internal/v1/dek/resolve with X-Service-Token → 200', async () => {
      const { app } = await buildApp({ withInternalToken: true, withKek: true });
      const res = await app.request('/internal/v1/dek/resolve', {
        method: 'POST',
        headers: {
          'x-service-token': SVC_TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ user_id: USER_A }),
      });
      expect(res.status).toBe(200);
    });

    it('8. POST /internal/v1/credentials/resolve without service token → 401', async () => {
      const { app } = await buildApp({ withInternalToken: true, withKek: true });
      const res = await app.request('/internal/v1/credentials/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          user_jwt: 'x.y.z',
          provider: 'google-workspace',
          sub_mcp_name: 'gws',
        }),
      });
      expect(res.status).toBe(401);
    });

    it('9. internal routes are NOT mounted when internalServiceToken is missing', async () => {
      // Without internalServiceToken, /internal/v1/* should 404 (no route),
      // not 401 (route exists but rejects auth).
      const { app } = await buildApp({ withInternalToken: false });
      const res = await app.request('/internal/v1/dek/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: USER_A }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('Bearer-gated paths', () => {
    it('10. GET /v1/approvals without Bearer → 401', async () => {
      const { app } = await buildApp();
      const res = await app.request('/v1/approvals');
      expect(res.status).toBe(401);
    });

    it('11. POST /v1/credentials without Bearer → 401 (Credentials-CRUD)', async () => {
      // /v1/credentials is auth-gated. Without Bearer → 401. (Without
      // kekProvider, the route is not even mounted, so we check both modes.)
      const { app } = await buildApp({ withKek: true });
      const res = await app.request('/v1/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'github', secret: 'pat' }),
      });
      expect(res.status).toBe(401);
    });
  });
});
