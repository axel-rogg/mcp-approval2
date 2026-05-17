/**
 * Integration-Test fuer GET /v1/passkeys.
 *
 * Scope:
 *   - ohne Bearer → 401
 *   - mit Bearer + leere Liste → {passkeys: []}
 *   - mit Bearer + 2 own + 1 fremder → returns own 2, sortiert by createdAt desc
 *   - bytea credentialId wird zu base64url konvertiert
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { AppBindings, ServerContext } from '../lib/context.js';
import type { AppConfig } from '../lib/config.js';
import type {
  DbAdapter,
  ScopedDb,
  RawDb,
  TransactionCtx,
} from '@mcp-approval2/adapters';
import { issueSessionJwt } from '../auth/session/issuer.js';
import { randomUuidV4 } from '@mcp-approval2/core';
import { requestId } from '../middleware/request-id.js';
import { errorHandler } from '../middleware/error-handler.js';
import { passkeysRoutes } from './passkeys.js';

interface Row {
  user_id: string;
  credential_id: Uint8Array;
  friendly_name: string | null;
  prf_supported: boolean;
  created_at: number;
  last_used_at: number | null;
  invalidated_at: number | null;
}

function makeMemoryDb(rows: Row[]): DbAdapter {
  function exec<T = unknown>(text: string, params: ReadonlyArray<unknown> = []): T[] {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t.includes('FROM webauthn_credentials') && t.startsWith('SELECT')) {
      const uid = String(params[0]);
      const out = rows
        .filter((r) => r.user_id === uid)
        .map((r) => ({
          credentialId: r.credential_id,
          friendlyName: r.friendly_name,
          prfSupported: r.prf_supported,
          createdAt: r.created_at,
          lastUsedAt: r.last_used_at,
          invalidatedAt: r.invalidated_at,
        }))
        .sort((a, b) => b.createdAt - a.createdAt);
      return out as unknown as T[];
    }
    return [] as unknown as T[];
  }

  const scoped = (userId: string): ScopedDb => ({
    userId,
    dialect: 'postgres',
    drizzle: {},
    async query<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
      return exec<T>(sql, params);
    },
  });
  const raw: RawDb = {
    dialect: 'postgres',
    drizzle: {},
    async query<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
      return exec<T>(sql, params);
    },
  };
  return {
    dialect: 'postgres',
    async scoped(userId: string) {
      return scoped(userId);
    },
    unsafe() {
      return raw;
    },
    async transaction<T>(
      userId: string,
      fn: (tx: ScopedDb, ctx: TransactionCtx) => Promise<T>,
    ) {
      return fn(scoped(userId), { userId, dialect: 'postgres' });
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
    GOOGLE_REDIRECT_URI: 'http://localhost:8787/auth/google/callback',
    RP_ID: 'localhost',
    RP_NAME: 'mcp-approval2',
    RP_ORIGIN: 'http://localhost:8787',
    INVITE_TTL_SEC: 24 * 60 * 60,
    RECOVERY_TTL_SEC: 24 * 60 * 60,
    ALLOWED_ORIGINS: [],
    COOKIE_DOMAIN: '',
    GOOGLE_ALLOWED_AUDIENCES: [],
    DCR_OPEN: true,
    DCR_ALLOWED_REDIRECT_HOSTS: [],
  };
}

async function makeBearer(userId: string, config: AppConfig): Promise<string> {
  const { token } = await issueSessionJwt(
    {
      userId,
      email: 'tester@example.com',
      role: 'member',
      sessionId: randomUuidV4(),
    },
    config,
  );
  return `Bearer ${token}`;
}

function buildApp(server: ServerContext): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use('*', requestId());
  app.onError(errorHandler());
  app.route('/', passkeysRoutes({ server }));
  return app;
}

describe('GET /v1/passkeys', () => {
  it('without bearer → 401', async () => {
    const app = buildApp({ config: makeConfig(), db: makeMemoryDb([]) });
    const res = await app.request('/v1/passkeys');
    expect(res.status).toBe(401);
  });

  it('empty list returns []', async () => {
    const config = makeConfig();
    const userId = randomUuidV4();
    const app = buildApp({ config, db: makeMemoryDb([]) });
    const auth = await makeBearer(userId, config);
    const res = await app.request('/v1/passkeys', { headers: { authorization: auth } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ passkeys: [] });
  });

  it('returns own credentials sorted desc, bytea→b64url, NULL friendly_name', async () => {
    const config = makeConfig();
    const userA = randomUuidV4();
    const userB = randomUuidV4();
    const rows: Row[] = [
      {
        user_id: userA,
        credential_id: new Uint8Array([1, 2, 3, 4]),
        friendly_name: 'iPhone Touch-ID',
        prf_supported: true,
        created_at: 1_000,
        last_used_at: 2_000,
        invalidated_at: null,
      },
      {
        user_id: userA,
        credential_id: new Uint8Array([0xff, 0xfe, 0xfd]),
        friendly_name: null,
        prf_supported: false,
        created_at: 5_000,
        last_used_at: null,
        invalidated_at: null,
      },
      {
        user_id: userB,
        credential_id: new Uint8Array([9, 9, 9]),
        friendly_name: 'leak',
        prf_supported: false,
        created_at: 4_000,
        last_used_at: null,
        invalidated_at: null,
      },
    ];
    const app = buildApp({ config, db: makeMemoryDb(rows) });
    const auth = await makeBearer(userA, config);
    const res = await app.request('/v1/passkeys', { headers: { authorization: auth } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      passkeys: Array<{
        credentialIdB64: string;
        friendlyName: string | null;
        createdAt: number;
      }>;
    };
    expect(body.passkeys).toHaveLength(2);
    // Sortiert desc by createdAt
    expect(body.passkeys[0]!.createdAt).toBe(5_000);
    expect(body.passkeys[1]!.createdAt).toBe(1_000);
    // bytea → base64url
    expect(body.passkeys[1]!.credentialIdB64).toBe('AQIDBA');
    expect(body.passkeys[0]!.credentialIdB64).toBe('__79');
    // NULL friendly_name passes through
    expect(body.passkeys[0]!.friendlyName).toBeNull();
    expect(body.passkeys[1]!.friendlyName).toBe('iPhone Touch-ID');
    // Kein fremder Passkey sichtbar
    expect(JSON.stringify(body)).not.toContain('leak');
  });
});
