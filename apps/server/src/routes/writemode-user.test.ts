/**
 * Integration-Tests fuer /v1/writemode/{status,activate,deactivate}-Routes.
 *
 * Coverage:
 *   - status: ohne Bearer → 401, mit Bearer → {active:false}, nach activate → {active:true}
 *   - activate: happy path mit stub-verifier, verifier-reject → 401, stale_ts → 400,
 *     invalide duration → 400 (Zod-strict)
 *   - deactivate: happy + idempotent (zweiter call → ended:0)
 *
 * Pattern analog approvals.test.ts: in-memory DbAdapter, echt-issued Session-JWT.
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
import { writemodeUserRoutes } from './writemode.js';
import { createWritemodeService } from '../services/writemode.js';

function makeMemoryDb(): DbAdapter {
  interface Row {
    id: string;
    user_id: string;
    activated_at: number;
    expires_at: number;
    activated_by_credential: string;
    method: string;
  }
  const rows = new Map<string, Row>();
  let nextId = 1;

  function exec<T = unknown>(text: string, params: ReadonlyArray<unknown> = []): T[] {
    const t = text.replace(/\s+/g, ' ').trim();

    if (t.startsWith('INSERT INTO write_mode')) {
      const [uid, activatedAt, expiresAt, credId, method] = params as readonly unknown[];
      const id = `id-${nextId++}`;
      const row: Row = {
        id,
        user_id: String(uid),
        activated_at: Number(activatedAt),
        expires_at: Number(expiresAt),
        activated_by_credential: String(credId),
        method: String(method),
      };
      rows.set(id, row);
      return [row] as unknown as T[];
    }
    if (t.startsWith('UPDATE write_mode')) {
      const [uid, now] = params as readonly unknown[];
      const affected: { id: string }[] = [];
      for (const r of rows.values()) {
        if (r.user_id === String(uid) && r.expires_at > Number(now)) {
          r.expires_at = Number(now);
          affected.push({ id: r.id });
        }
      }
      return affected as unknown as T[];
    }
    if (t.startsWith('SELECT id FROM write_mode')) {
      const [uid, now] = params as readonly unknown[];
      for (const r of rows.values()) {
        if (r.user_id === String(uid) && r.expires_at > Number(now)) {
          return [{ id: r.id }] as unknown as T[];
        }
      }
      return [] as unknown as T[];
    }
    if (t.startsWith('SELECT id, user_id, activated_at')) {
      const [uid, now] = params as readonly unknown[];
      const matches: Row[] = [];
      for (const r of rows.values()) {
        if (r.user_id === String(uid) && r.expires_at > Number(now)) matches.push(r);
      }
      matches.sort((a, b) => b.expires_at - a.expires_at);
      return matches as unknown as T[];
    }
    // audit_log INSERT — swallow
    if (t.startsWith('INSERT INTO audit_log') || t.includes('audit_log')) {
      return [] as unknown as T[];
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

function buildApp(deps: {
  server: ServerContext;
  verifyActivation: (args: unknown) => Promise<void>;
  now?: () => number;
}): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use('*', requestId());
  app.onError(errorHandler());
  const wm = createWritemodeService({ db: deps.server.db });
  app.route(
    '/',
    writemodeUserRoutes({
      server: deps.server,
      writemode: wm,
      verifyActivation: deps.verifyActivation as never,
      ...(deps.now ? { now: deps.now } : {}),
    }),
  );
  return app;
}

const okVerifier = async (): Promise<void> => {};
const failVerifier = async (): Promise<void> => {
  const { HttpError } = await import('../lib/errors.js');
  throw HttpError.unauthorized('webauthn_verification_failed');
};

function activateBody(now: number) {
  return {
    duration: 15,
    ts: now,
    credentialIdB64: 'cred-abc',
    authenticatorDataB64: 'AAAA',
    clientDataJsonB64: 'AAAA',
    signatureB64: 'AAAA',
  };
}

describe('writemode user routes', () => {
  it('GET /v1/writemode/status without bearer → 401', async () => {
    const config = makeConfig();
    const app = buildApp({
      server: { config, db: makeMemoryDb() },
      verifyActivation: okVerifier,
    });
    const res = await app.request('/v1/writemode/status');
    expect(res.status).toBe(401);
  });

  it('status with bearer + no active → {active:false}', async () => {
    const config = makeConfig();
    const userId = randomUuidV4();
    const app = buildApp({
      server: { config, db: makeMemoryDb() },
      verifyActivation: okVerifier,
    });
    const auth = await makeBearer(userId, config);
    const res = await app.request('/v1/writemode/status', {
      headers: { authorization: auth },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ active: false, sessions: [] });
  });

  it('activate happy → status flips active, deactivate ends', async () => {
    const config = makeConfig();
    const userId = randomUuidV4();
    const fixedNow = 1_700_000_000_000;
    const app = buildApp({
      server: { config, db: makeMemoryDb() },
      verifyActivation: okVerifier,
      now: () => fixedNow,
    });
    const auth = await makeBearer(userId, config);

    const r1 = await app.request('/v1/writemode/activate', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(activateBody(fixedNow)),
    });
    expect(r1.status).toBe(200);
    const body1 = (await r1.json()) as {
      ok: boolean;
      session: { expires_at: number };
    };
    expect(body1.ok).toBe(true);
    expect(body1.session.expires_at).toBe(fixedNow + 15 * 60_000);

    const r2 = await app.request('/v1/writemode/status', {
      headers: { authorization: auth },
    });
    const body2 = (await r2.json()) as {
      active: boolean;
      sessions: Array<{ id: string }>;
    };
    expect(body2.active).toBe(true);
    expect(body2.sessions).toHaveLength(1);

    const r3 = await app.request('/v1/writemode/deactivate', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
    });
    expect(r3.status).toBe(200);
    expect(await r3.json()).toMatchObject({ ok: true, ended: 1 });

    const r4 = await app.request('/v1/writemode/status', {
      headers: { authorization: auth },
    });
    expect(await r4.json()).toMatchObject({ active: false });
  });

  it('activate with rejecting verifier → 401, no session created', async () => {
    const config = makeConfig();
    const userId = randomUuidV4();
    const fixedNow = 1_700_000_000_000;
    const app = buildApp({
      server: { config, db: makeMemoryDb() },
      verifyActivation: failVerifier,
      now: () => fixedNow,
    });
    const auth = await makeBearer(userId, config);

    const r1 = await app.request('/v1/writemode/activate', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(activateBody(fixedNow)),
    });
    expect(r1.status).toBe(401);

    const r2 = await app.request('/v1/writemode/status', {
      headers: { authorization: auth },
    });
    expect(await r2.json()).toMatchObject({ active: false });
  });

  it('activate with stale ts → 400', async () => {
    const config = makeConfig();
    const userId = randomUuidV4();
    const fixedNow = 1_700_000_000_000;
    const app = buildApp({
      server: { config, db: makeMemoryDb() },
      verifyActivation: okVerifier,
      now: () => fixedNow,
    });
    const auth = await makeBearer(userId, config);

    const r = await app.request('/v1/writemode/activate', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(activateBody(fixedNow - 10 * 60_000)),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error?: { details?: { reason?: string } } };
    expect(body.error?.details?.reason).toBe('stale_timestamp');
  });

  it('activate with invalid duration → 400 (Zod-strict)', async () => {
    const config = makeConfig();
    const userId = randomUuidV4();
    const fixedNow = 1_700_000_000_000;
    const app = buildApp({
      server: { config, db: makeMemoryDb() },
      verifyActivation: okVerifier,
      now: () => fixedNow,
    });
    const auth = await makeBearer(userId, config);
    const bad = { ...activateBody(fixedNow), duration: 30 };
    const r = await app.request('/v1/writemode/activate', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(bad),
    });
    expect(r.status).toBe(400);
  });

  it('deactivate idempotent: zweiter call → ended:0', async () => {
    const config = makeConfig();
    const userId = randomUuidV4();
    const fixedNow = 1_700_000_000_000;
    const app = buildApp({
      server: { config, db: makeMemoryDb() },
      verifyActivation: okVerifier,
      now: () => fixedNow,
    });
    const auth = await makeBearer(userId, config);
    await app.request('/v1/writemode/activate', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(activateBody(fixedNow)),
    });
    const r1 = await app.request('/v1/writemode/deactivate', {
      method: 'POST',
      headers: { authorization: auth },
    });
    expect(await r1.json()).toMatchObject({ ended: 1 });
    const r2 = await app.request('/v1/writemode/deactivate', {
      method: 'POST',
      headers: { authorization: auth },
    });
    expect(await r2.json()).toMatchObject({ ended: 0 });
  });
});
