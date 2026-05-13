/**
 * Smoke-Tests fuer /v1/credentials/*-Routes.
 *
 * Wir bauen die App mit echtem Hono + mocked CredentialsService + InMemory
 * PrfSessionService. Echte JWT-Issuance, damit das auth-Middleware-Glue mit
 * lauft.
 */
import { describe, it, expect } from 'vitest';
import { createApp } from '../index.js';
import type { ServerContext } from '../lib/context.js';
import type { AppConfig } from '../lib/config.js';
import type { DbAdapter, ScopedDb } from '@mcp-approval2/adapters';
import { issueSessionJwt } from '../auth/session/issuer.js';
import { randomUuidV4 } from '@mcp-approval2/core';
import {
  type CredentialsService,
  type CredentialMeta,
  PrfRequiredError,
} from '../services/credentials.js';
import { createPrfSessionService } from '../services/prf-session.js';

function makeStubDb(): DbAdapter {
  const scoped: ScopedDb = {
    userId: 'test',
    dialect: 'postgres',
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
    dialect: 'postgres',
    async scoped() {
      return scoped;
    },
    unsafe() {
      return raw;
    },
    async transaction<T>(_uid, fn) {
      return fn(scoped, { userId: 'test', dialect: 'postgres' });
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
    INVITE_TTL_SEC: 24 * 60 * 60,
    RECOVERY_TTL_SEC: 24 * 60 * 60,
  };
}

interface MockState {
  rows: Map<string, CredentialMeta & { secret: string }>;
}

function makeMockService(state: MockState): CredentialsService {
  return {
    async create(args) {
      const id = randomUuidV4();
      if ((args.prfEnabled ?? true) && !args.prfOutput) {
        throw Object.assign(new Error('invalid'), { code: 'invalid_request' });
      }
      const meta: CredentialMeta = {
        id,
        ownerId: args.userId,
        provider: args.provider,
        kind: args.kind,
        label: args.label,
        prfEnabled: args.prfEnabled ?? true,
        prfCredentialId: args.prfCredentialId ?? null,
        metadata: args.metadata ?? null,
        createdAt: Date.now(),
        rotatedAt: null,
        lastUsedAt: null,
        expiresAt: args.expiresAt ?? null,
      };
      state.rows.set(id, { ...meta, secret: args.secret });
      return meta;
    },
    async read(args) {
      const row = state.rows.get(args.credentialId);
      if (!row || row.ownerId !== args.userId) {
        const err = new Error('not_found');
        Object.assign(err, { code: 'not_found' });
        throw err;
      }
      if (row.prfEnabled && !args.prfOutput) {
        throw new PrfRequiredError(row.prfCredentialId);
      }
      const { secret, ...meta } = row;
      return { secret, meta };
    },
    async list(args) {
      return Array.from(state.rows.values())
        .filter((r) => r.ownerId === args.userId)
        .filter((r) => !args.provider || r.provider === args.provider)
        .map(({ secret: _s, ...m }) => m);
    },
    async rotate(args) {
      const row = state.rows.get(args.credentialId);
      if (!row || row.ownerId !== args.userId) {
        const err = new Error('not_found');
        Object.assign(err, { code: 'not_found' });
        throw err;
      }
      if (row.prfEnabled && !args.prfOutput) {
        throw new PrfRequiredError(row.prfCredentialId);
      }
      state.rows.set(args.credentialId, { ...row, secret: args.newSecret, rotatedAt: Date.now() });
    },
    async delete(args) {
      state.rows.delete(args.credentialId);
    },
    async resolveForSubMcp(args) {
      const label = args.label ?? 'default';
      const row = Array.from(state.rows.values()).find(
        (r) => r.ownerId === args.userId && r.provider === args.provider && r.label === label,
      );
      if (!row) {
        const err = new Error('not_found');
        Object.assign(err, { code: 'not_found' });
        throw err;
      }
      return { secret: row.secret, expiresAt: row.expiresAt };
    },
  };
}

async function makeBearer(userId: string, config: AppConfig): Promise<string> {
  const { token } = await issueSessionJwt(
    { userId, email: 'test@example.com', role: 'member', sessionId: randomUuidV4() },
    config,
  );
  return `Bearer ${token}`;
}

describe('credentials routes', () => {
  it('POST /v1/credentials without bearer → 401', async () => {
    const config = makeConfig();
    const state: MockState = { rows: new Map() };
    const app = await createApp(
      { config, db: makeStubDb() },
      { credentials: makeMockService(state), prfSessions: createPrfSessionService() },
    );
    const res = await app.request('/v1/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'jira', kind: 'api_token', label: 'a', secret: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /v1/credentials prfEnabled=false succeeds, returns metadata', async () => {
    const config = makeConfig();
    const state: MockState = { rows: new Map() };
    const userId = randomUuidV4();
    const app = await createApp(
      { config, db: makeStubDb() },
      { credentials: makeMockService(state), prfSessions: createPrfSessionService() },
    );
    const auth = await makeBearer(userId, config);
    const res = await app.request('/v1/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({
        provider: 'jira',
        kind: 'api_token',
        label: 'work',
        secret: 'pat',
        prfEnabled: false,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { credential: { id: string; provider: string } };
    expect(body.credential.provider).toBe('jira');
    expect(body.credential.id).toBeDefined();
  });

  it('GET /v1/credentials returns list (no secret leak)', async () => {
    const config = makeConfig();
    const state: MockState = { rows: new Map() };
    const userId = randomUuidV4();
    const app = await createApp(
      { config, db: makeStubDb() },
      { credentials: makeMockService(state), prfSessions: createPrfSessionService() },
    );
    const auth = await makeBearer(userId, config);
    await app.request('/v1/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({
        provider: 'jira',
        kind: 'api_token',
        label: 'work',
        secret: 'pat',
        prfEnabled: false,
      }),
    });
    const res = await app.request('/v1/credentials', { headers: { authorization: auth } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credentials: Array<Record<string, unknown>> };
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0]?.secret).toBeUndefined();
  });

  it('GET /v1/credentials/:id?reveal=1 prf_enabled without session → 428', async () => {
    const config = makeConfig();
    const state: MockState = { rows: new Map() };
    const userId = randomUuidV4();
    const app = await createApp(
      { config, db: makeStubDb() },
      { credentials: makeMockService(state), prfSessions: createPrfSessionService() },
    );
    const auth = await makeBearer(userId, config);
    // Insert mit prf default-on
    state.rows.set('cred-1', {
      id: 'cred-1',
      ownerId: userId,
      provider: 'jira',
      kind: 'api_token',
      label: 'x',
      prfEnabled: true,
      prfCredentialId: null,
      metadata: null,
      createdAt: Date.now(),
      rotatedAt: null,
      lastUsedAt: null,
      expiresAt: null,
      secret: 'opaque',
    });
    const res = await app.request('/v1/credentials/cred-1?reveal=1', {
      headers: { authorization: auth },
    });
    expect(res.status).toBe(428);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('prf_required');
  });

  it('POST /v1/credentials/prf-session stores 32-byte output, GET reveal works', async () => {
    const config = makeConfig();
    const state: MockState = { rows: new Map() };
    const userId = randomUuidV4();
    const prfSessions = createPrfSessionService();
    const app = await createApp(
      { config, db: makeStubDb() },
      { credentials: makeMockService(state), prfSessions },
    );
    const auth = await makeBearer(userId, config);

    // Seed credential prf_enabled=true
    state.rows.set('cred-2', {
      id: 'cred-2',
      ownerId: userId,
      provider: 'jira',
      kind: 'api_token',
      label: 'y',
      prfEnabled: true,
      prfCredentialId: null,
      metadata: null,
      createdAt: Date.now(),
      rotatedAt: null,
      lastUsedAt: null,
      expiresAt: null,
      secret: 'unwrapped',
    });

    // Encode 32 bytes
    const buf = new Uint8Array(32).fill(7);
    let b64 = '';
    for (let i = 0; i < buf.length; i++) b64 += String.fromCharCode(buf[i] ?? 0);
    const prfOutputB64 = btoa(b64);

    const sessRes = await app.request('/v1/credentials/prf-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({ prfOutputB64 }),
    });
    expect(sessRes.status).toBe(201);
    const sessBody = (await sessRes.json()) as { prfSessionId: string };
    expect(sessBody.prfSessionId).toBeDefined();

    const revealRes = await app.request(
      `/v1/credentials/cred-2?reveal=1&prfSessionId=${sessBody.prfSessionId}`,
      { headers: { authorization: auth } },
    );
    expect(revealRes.status).toBe(200);
    const body = (await revealRes.json()) as { secret: string };
    expect(body.secret).toBe('unwrapped');
  });

  it('DELETE /v1/credentials/:id → 200', async () => {
    const config = makeConfig();
    const state: MockState = { rows: new Map() };
    const userId = randomUuidV4();
    const app = await createApp(
      { config, db: makeStubDb() },
      { credentials: makeMockService(state), prfSessions: createPrfSessionService() },
    );
    const auth = await makeBearer(userId, config);
    state.rows.set('cred-3', {
      id: 'cred-3',
      ownerId: userId,
      provider: 'jira',
      kind: 'api_token',
      label: 'z',
      prfEnabled: false,
      prfCredentialId: null,
      metadata: null,
      createdAt: Date.now(),
      rotatedAt: null,
      lastUsedAt: null,
      expiresAt: null,
      secret: 's',
    });
    const res = await app.request('/v1/credentials/cred-3', {
      method: 'DELETE',
      headers: { authorization: auth },
    });
    expect(res.status).toBe(200);
    expect(state.rows.has('cred-3')).toBe(false);
  });

  it('/health remains OK with credentials routes mounted', async () => {
    const config = makeConfig();
    const state: MockState = { rows: new Map() };
    const app = await createApp(
      { config, db: makeStubDb() },
      { credentials: makeMockService(state), prfSessions: createPrfSessionService() },
    );
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });
});
