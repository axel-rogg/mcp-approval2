/**
 * Integration test fuer POST /internal/v1/dek/resolve + die Service-Token-
 * Middleware. Wir bauen eine minimale Hono-App mit:
 *   - requestId-Middleware
 *   - serviceTokenMiddleware mit fixem expected-token
 *   - internalDekRoutes
 *
 * Db ist in-memory (siehe dek.test.ts pattern). Kek ist LocalKekProvider.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { LocalKekProvider } from '@mcp-approval2/adapters';
import type { DbAdapter, RawDb, ScopedDb } from '@mcp-approval2/adapters';
import { randomBytes } from '@mcp-approval2/core';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import type { AppConfig } from '../../lib/config.js';
import { requestId } from '../../middleware/request-id.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { serviceTokenMiddleware } from '../../middleware/service-token.js';
import { createDekService } from '../../services/dek.js';
import { internalDekRoutes } from './dek.js';

const SVC_TOKEN = 'a'.repeat(48);
const USER_A = '11111111-1111-1111-1111-111111111111';

interface SeedRow {
  user_id: string;
  wrapped_dek: Uint8Array;
  kek_ref: string;
  created_at: number;
  rotated_at: number | null;
}

function makeMemoryDb(): DbAdapter & { _audit: unknown[]; _seeds: Map<string, SeedRow> } {
  const seeds = new Map<string, SeedRow>();
  const audit: unknown[] = [];

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
      audit.push(params);
      return [] as unknown as T[];
    }
    if (t.startsWith('UPDATE user_dek_seeds') || t.startsWith('DELETE FROM user_dek_seeds')) {
      return [] as unknown as T[];
    }
    throw new Error('unmocked SQL: ' + t.slice(0, 80));
  }

  const raw: RawDb = {
    dialect: 'postgres',
    drizzle: {},
    async query<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
      return exec<T>(sql, params);
    },
  };

  return {
    _audit: audit,
    _seeds: seeds,
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
    GOOGLE_CLIENT_ID: 'stub',
    GOOGLE_CLIENT_SECRET: 'stub',
    GOOGLE_REDIRECT_URI: 'http://localhost:8787/cb',
    RP_ID: 'localhost',
    RP_NAME: 'mcp-approval2',
    RP_ORIGIN: 'http://localhost:8787',
    INVITE_TTL_SEC: 86400,
    RECOVERY_TTL_SEC: 86400,
  };
}

function buildApp(): { app: Hono<AppBindings>; db: ReturnType<typeof makeMemoryDb> } {
  const db = makeMemoryDb();
  const server: ServerContext = { config: makeConfig(), db };
  const kek = new LocalKekProvider({ masterKey: randomBytes(32) });
  const dek = createDekService({ db, kekProvider: kek });

  const app = new Hono<AppBindings>();
  app.use('*', requestId());
  app.onError(errorHandler());
  app.use(
    '/internal/v1/*',
    serviceTokenMiddleware({ server, expectedToken: SVC_TOKEN }),
  );
  app.route('/', internalDekRoutes({ server, dek }));
  return { app, db };
}

describe('POST /internal/v1/dek/resolve', () => {
  it('200 + dek_b64 with valid Bearer service token', async () => {
    const { app } = buildApp();
    const res = await app.request('/internal/v1/dek/resolve', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${SVC_TOKEN}`,
        'content-type': 'application/json',
        'x-request-id': 'req-xyz-123456',
      },
      body: JSON.stringify({ user_id: USER_A }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dek_b64: string };
    expect(body.dek_b64).toBeTypeOf('string');
    const decoded = Buffer.from(body.dek_b64, 'base64');
    expect(decoded.byteLength).toBe(32);
  });

  it('200 + dek_b64 with X-Service-Token header', async () => {
    const { app } = buildApp();
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

  it('401 when service token missing', async () => {
    const { app } = buildApp();
    const res = await app.request('/internal/v1/dek/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: USER_A }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('401 when service token wrong', async () => {
    const { app } = buildApp();
    const res = await app.request('/internal/v1/dek/resolve', {
      method: 'POST',
      headers: {
        'authorization': 'Bearer wrong-token-but-same-length-padding-aaaaaaa',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ user_id: USER_A }),
    });
    expect(res.status).toBe(401);
  });

  it('400 when user_id is not a UUID', async () => {
    const { app } = buildApp();
    const res = await app.request('/internal/v1/dek/resolve', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${SVC_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ user_id: 'not-a-uuid' }),
    });
    expect(res.status).toBe(400);
  });

  it('idempotent — repeat call returns same DEK', async () => {
    const { app } = buildApp();
    const headers = {
      'authorization': `Bearer ${SVC_TOKEN}`,
      'content-type': 'application/json',
    };
    const body = JSON.stringify({ user_id: USER_A });
    const r1 = await app.request('/internal/v1/dek/resolve', { method: 'POST', headers, body });
    const r2 = await app.request('/internal/v1/dek/resolve', { method: 'POST', headers, body });
    const b1 = (await r1.json()) as { dek_b64: string };
    const b2 = (await r2.json()) as { dek_b64: string };
    expect(b1.dek_b64).toBe(b2.dek_b64);
  });

  it('response body never contains the dek hex', async () => {
    const { app, db } = buildApp();
    const res = await app.request('/internal/v1/dek/resolve', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${SVC_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ user_id: USER_A }),
    });
    const body = (await res.json()) as { dek_b64: string };
    const dekHex = Buffer.from(body.dek_b64, 'base64').toString('hex');
    // Audit-log captured params should NEVER include the DEK bytes (hex
    // form would be the obvious accidental serialization).
    for (const audit of db._audit) {
      const serialized = JSON.stringify(audit);
      expect(serialized).not.toContain(dekHex);
    }
  });
});
