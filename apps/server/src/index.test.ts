/**
 * Smoke-Tests fuer den Hono-Server.
 *
 * Diese Tests umgehen `createServerContext` und injizieren einen Stub-
 * `DbAdapter`, damit kein Postgres laufen muss.
 */
import { describe, it, expect } from 'vitest';
import { createApp } from './index.js';
import type { ServerContext } from './lib/context.js';
import type { AppConfig } from './lib/config.js';

// Minimaler in-memory DB-Stub. Wir simulieren `query` mit einer Map fuer
// `users`-Counts (Bootstrap-Test). Andere queries liefern leere Arrays.
function makeStubDb(): ServerContext['db'] {
  const state = {
    users: new Map<string, { id: string; email: string; role: 'admin' | 'member'; status: string }>(),
    revoked: new Set<string>(),
  };
  void state; // reserved for future stub-extensions

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
    async transaction<T>(_uid: string, fn: (tx: typeof scoped, ctx: { userId: string; dialect: 'postgres' }) => Promise<T>): Promise<T> {
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

describe('server skeleton', () => {
  it('GET /health → 200 with ok status', async () => {
    const ctx: ServerContext = { config: makeStubConfig(), db: makeStubDb() };
    const app = await createApp(ctx);
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string; requestId: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('mcp-approval2');
    expect(body.requestId.length).toBeGreaterThan(0);
  });

  it('protected endpoint without Bearer → 401', async () => {
    const ctx: ServerContext = { config: makeStubConfig(), db: makeStubDb() };
    const app = await createApp(ctx);
    const res = await app.request('/auth/logout', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('admin invite without Bearer → 401', async () => {
    const ctx: ServerContext = { config: makeStubConfig(), db: makeStubDb() };
    const app = await createApp(ctx);
    const res = await app.request('/admin/invites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com' }),
    });
    expect(res.status).toBe(401);
  });

  it('accept-invite redirects to google start with token', async () => {
    const ctx: ServerContext = { config: makeStubConfig(), db: makeStubDb() };
    const app = await createApp(ctx);
    const res = await app.request('/accept-invite/abc123');
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('/auth/google/start');
    expect(loc).toContain('invite=abc123');
  });
});
