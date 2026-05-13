/**
 * Unit-Tests: Sub-MCP-Gateway (Registry + Forwarder + Discovery + Resolve-Endpoint).
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.4, §9.
 */
import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import type { DbAdapter, RawDb, ScopedDb } from '@mcp-approval2/adapters';
import { createSubMcpRegistry, hashServiceToken } from './registry.js';
import { SubMcpForwarder } from './forwarder.js';
import { refreshSubMcpToolCache, buildForwardedToolDefs } from './discovery.js';
import { SubMcpError, SubMcpForwardError, SubMcpNotFoundError, type SubMcpServerConfig } from './types.js';
import type { AppConfig } from '../../lib/config.js';
import type { ServerContext } from '../../lib/context.js';
import { internalCredentialsRoutes } from '../../routes/internal/credentials.js';
import { Hono } from 'hono';
import { errorHandler } from '../../middleware/error-handler.js';
import type { CredentialsService } from '../../services/credentials.js';
import { PrfRequiredError } from '../../services/credentials.js';

// ===========================================================================
// In-Memory DbAdapter Stub
// ===========================================================================

interface SubMcpRow {
  id: string;
  name: string;
  display_name: string;
  base_url: string;
  auth_mode: string;
  auth_config: Record<string, unknown>;
  enabled: boolean;
  tools_cache: unknown;
  tools_cached_at: number | null;
  created_at: number;
  updated_at: number;
}

function makeStubDb(rows: SubMcpRow[] = []): { db: DbAdapter; rows: SubMcpRow[]; auditEvents: unknown[] } {
  const auditEvents: unknown[] = [];

  function query<T = unknown>(sql: string, params?: ReadonlyArray<unknown>): Promise<T[]> {
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith('SELECT')) {
      if (sql.includes('FROM sub_mcp_servers')) {
        return Promise.resolve([...rows].sort((a, b) => a.name.localeCompare(b.name)) as unknown as T[]);
      }
      return Promise.resolve([] as T[]);
    }
    if (trimmed.startsWith('UPDATE')) {
      if (sql.includes('sub_mcp_servers')) {
        // Match either tools_cache update (5 params: cache, ts, ts, id) or register
        const [cache, ts, , id] = params ?? [];
        const row = rows.find((r) => r.id === id);
        if (row) {
          row.tools_cache = typeof cache === 'string' ? JSON.parse(cache) : cache;
          row.tools_cached_at = ts as number;
          row.updated_at = ts as number;
        }
      }
      return Promise.resolve([] as T[]);
    }
    if (trimmed.startsWith('INSERT')) {
      if (sql.includes('sub_mcp_servers')) {
        const [name, display, base, mode, cfg, enabled, ts] = params ?? [];
        const row: SubMcpRow = {
          id: `id-${rows.length + 1}`,
          name: String(name),
          display_name: String(display),
          base_url: String(base),
          auth_mode: String(mode),
          auth_config: typeof cfg === 'string' ? (JSON.parse(cfg) as Record<string, unknown>) : (cfg as Record<string, unknown>),
          enabled: Boolean(enabled),
          tools_cache: null,
          tools_cached_at: null,
          created_at: ts as number,
          updated_at: ts as number,
        };
        rows.push(row);
        return Promise.resolve([row] as unknown as T[]);
      }
      if (sql.includes('audit_log')) {
        auditEvents.push(params);
        return Promise.resolve([] as T[]);
      }
      return Promise.resolve([] as T[]);
    }
    return Promise.resolve([] as T[]);
  }

  const raw: RawDb = { dialect: 'postgres', drizzle: {}, query };
  const scoped: ScopedDb = { userId: 'stub', dialect: 'postgres', drizzle: {}, query };
  const db: DbAdapter = {
    dialect: 'postgres',
    async scoped() {
      return scoped;
    },
    unsafe() {
      return raw;
    },
    async transaction<T>(_uid: string, fn: (s: ScopedDb) => Promise<T>): Promise<T> {
      return fn(scoped);
    },
    async migrate() {},
    async close() {},
  };
  return { db, rows, auditEvents };
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
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
    GOOGLE_CLIENT_ID: 'g',
    GOOGLE_CLIENT_SECRET: 'gs',
    GOOGLE_REDIRECT_URI: 'http://localhost:8787/auth/google/callback',
    RP_ID: 'localhost',
    RP_NAME: 'mcp-approval2',
    RP_ORIGIN: 'http://localhost:8787',
    INVITE_TTL_SEC: 24 * 60 * 60,
    RECOVERY_TTL_SEC: 24 * 60 * 60,
    ...overrides,
  };
}

function makeServer(db: DbAdapter): ServerContext {
  return { config: makeConfig(), db };
}

async function makeUserJwt(userId: string, aud: string, config: AppConfig, ttlSec = 60): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(config.JWT_ISSUER)
    .setAudience(aud)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSec)
    .sign(new TextEncoder().encode(config.JWT_SECRET));
}

// ===========================================================================
// Tests
// ===========================================================================

describe('SubMcpRegistry', () => {
  it('getByName returns config; rejects unknown', async () => {
    const plainToken = 'plain-token-cf';
    const { db, rows } = makeStubDb();
    rows.push({
      id: 'id-1',
      name: 'cf',
      display_name: 'Cloudflare',
      base_url: 'https://cf.example.test',
      auth_mode: 'service_bearer',
      auth_config: { service_token_hash: hashServiceToken(plainToken) },
      enabled: true,
      tools_cache: null,
      tools_cached_at: null,
      created_at: 1,
      updated_at: 1,
    });
    const registry = createSubMcpRegistry({
      db,
      serviceTokenResolver: (n) => (n === 'cf' ? plainToken : null),
    });
    const cfg = await registry.getByName('cf');
    expect(cfg.name).toBe('cf');
    expect(cfg.serviceToken).toBe(plainToken);
    expect(cfg.baseUrl).toBe('https://cf.example.test');

    await expect(registry.getByName('unknown')).rejects.toBeInstanceOf(SubMcpNotFoundError);
  });

  it('verifyServiceToken accepts correct token, rejects wrong', async () => {
    const plain = 'super-secret';
    const { db, rows } = makeStubDb();
    rows.push({
      id: 'id-1',
      name: 'gws',
      display_name: 'GWS',
      base_url: 'https://gws.example.test',
      auth_mode: 'service_bearer',
      auth_config: { service_token_hash: hashServiceToken(plain) },
      enabled: true,
      tools_cache: null,
      tools_cached_at: null,
      created_at: 1,
      updated_at: 1,
    });
    const registry = createSubMcpRegistry({ db, serviceTokenResolver: () => plain });
    const ok = await registry.verifyServiceToken('gws', plain);
    expect(ok?.name).toBe('gws');
    const bad = await registry.verifyServiceToken('gws', 'wrong');
    expect(bad).toBeNull();
  });

  it('updateToolsCache writes to row', async () => {
    const { db, rows } = makeStubDb();
    rows.push({
      id: 'id-1',
      name: 'cf',
      display_name: 'CF',
      base_url: 'https://cf.test',
      auth_mode: 'service_bearer',
      auth_config: { service_token_hash: hashServiceToken('t') },
      enabled: true,
      tools_cache: null,
      tools_cached_at: null,
      created_at: 1,
      updated_at: 1,
    });
    const registry = createSubMcpRegistry({ db, serviceTokenResolver: () => 't' });
    await registry.updateToolsCache('id-1', [{ name: 'list', description: 'List zones' }]);
    expect(rows[0]?.tools_cache).toEqual([{ name: 'list', description: 'List zones' }]);
  });
});

describe('SubMcpForwarder', () => {
  function makeRegistryFor(cfg: SubMcpServerConfig) {
    return {
      async getByName(n: string) {
        if (n !== cfg.name) throw new SubMcpNotFoundError(n);
        return cfg;
      },
      async listEnabled() {
        return [cfg];
      },
      async listAll() {
        return [cfg];
      },
      async updateToolsCache() {},
      async verifyServiceToken() {
        return null;
      },
      async register() {
        throw new Error('not supported in stub');
      },
      invalidate() {},
    };
  }

  const cfg: SubMcpServerConfig = {
    id: 'id-1',
    name: 'gws',
    displayName: 'GWS',
    baseUrl: 'https://gws.test',
    authMode: 'service_bearer',
    authConfig: { service_token_hash: hashServiceToken('t') },
    enabled: true,
    serviceToken: 't',
    toolsCache: null,
    toolsCachedAt: null,
    createdAt: 1,
    updatedAt: 1,
  };

  it('forwards tools/call with auth headers and parses result', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const fakeFetch: typeof fetch = async (input, init) => {
      captured.url = String(input);
      captured.init = init ?? undefined;
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: '1', result: { content: [{ type: 'text', text: 'ok' }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const fwd = new SubMcpForwarder({ registry: makeRegistryFor(cfg), fetchImpl: fakeFetch });
    const result = await fwd.forwardToolCall({
      subMcpName: 'gws',
      toolName: 'calendar.list',
      input: { max: 5 },
      userJwt: 'user-jwt-x',
    });
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(captured.url).toBe('https://gws.test/mcp');
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer t');
    expect(headers['x-user-jwt']).toBe('user-jwt-x');
    const body = JSON.parse(String(captured.init?.body)) as {
      method: string;
      params: { name: string; arguments: unknown };
    };
    expect(body.method).toBe('tools/call');
    expect(body.params).toEqual({ name: 'calendar.list', arguments: { max: 5 } });
  });

  it('throws SubMcpForwardError on non-2xx', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('upstream busted', { status: 502, headers: { 'content-type': 'text/plain' } });
    const fwd = new SubMcpForwarder({ registry: makeRegistryFor(cfg), fetchImpl: fakeFetch });
    const p = fwd.forwardToolCall({
      subMcpName: 'gws',
      toolName: 'x',
      input: {},
      userJwt: 'j',
    });
    await expect(p).rejects.toBeInstanceOf(SubMcpForwardError);
    await p.catch((err: SubMcpForwardError) => {
      expect(err.status).toBe(502);
    });
  });

  it('throws SubMcpError on json-rpc error body', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({ jsonrpc: '2.0', id: '1', error: { code: -32602, message: 'bad params' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const fwd = new SubMcpForwarder({ registry: makeRegistryFor(cfg), fetchImpl: fakeFetch });
    await expect(
      fwd.forwardToolCall({ subMcpName: 'gws', toolName: 'x', input: {}, userJwt: 'j' }),
    ).rejects.toBeInstanceOf(SubMcpError);
  });

  it('parses text/event-stream responses', async () => {
    const sse =
      'event: message\n' +
      'data: {"jsonrpc":"2.0","id":"1","result":{"content":[{"type":"text","text":"sse"}]}}\n\n';
    const fakeFetch: typeof fetch = async () =>
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const fwd = new SubMcpForwarder({ registry: makeRegistryFor(cfg), fetchImpl: fakeFetch });
    const result = await fwd.forwardToolCall({
      subMcpName: 'gws',
      toolName: 'x',
      input: {},
      userJwt: 'j',
    });
    expect(result).toEqual({ content: [{ type: 'text', text: 'sse' }] });
  });

  it('SubMcpNotFoundError when sub-mcp not registered', async () => {
    const reg = makeRegistryFor(cfg);
    const fwd = new SubMcpForwarder({ registry: reg, fetchImpl: fetch });
    await expect(
      fwd.forwardToolCall({ subMcpName: 'unknown', toolName: 'x', input: {}, userJwt: 'j' }),
    ).rejects.toBeInstanceOf(SubMcpNotFoundError);
  });
});

describe('refreshSubMcpToolCache', () => {
  it('lists tools and writes cache', async () => {
    const { db, rows } = makeStubDb();
    rows.push({
      id: 'id-1',
      name: 'cf',
      display_name: 'CF',
      base_url: 'https://cf.test',
      auth_mode: 'service_bearer',
      auth_config: { service_token_hash: hashServiceToken('t') },
      enabled: true,
      tools_cache: null,
      tools_cached_at: null,
      created_at: 1,
      updated_at: 1,
    });
    const registry = createSubMcpRegistry({ db, serviceTokenResolver: () => 't' });
    const fakeFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as { method: string };
      expect(body.method).toBe('tools/list');
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          result: {
            tools: [
              { name: 'zones.list', description: 'List zones', inputSchema: { type: 'object' } },
              { name: 'workers.deploy' },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const results = await refreshSubMcpToolCache({ registry, fetchImpl: fakeFetch });
    expect(results).toEqual([{ subMcpName: 'cf', count: 2 }]);
    expect(rows[0]?.tools_cache).toHaveLength(2);
  });

  it('does not throw on per-server error, captures error in result', async () => {
    const { db, rows } = makeStubDb();
    rows.push({
      id: 'id-1',
      name: 'broken',
      display_name: 'Broken',
      base_url: 'https://broken.test',
      auth_mode: 'service_bearer',
      auth_config: { service_token_hash: hashServiceToken('t') },
      enabled: true,
      tools_cache: null,
      tools_cached_at: null,
      created_at: 1,
      updated_at: 1,
    });
    const registry = createSubMcpRegistry({ db, serviceTokenResolver: () => 't' });
    const fakeFetch: typeof fetch = async () => new Response('boom', { status: 500 });
    const results = await refreshSubMcpToolCache({ registry, fetchImpl: fakeFetch });
    expect(results[0]?.subMcpName).toBe('broken');
    expect(results[0]?.count).toBe(0);
    expect(results[0]?.error).toBeDefined();
  });
});

describe('buildForwardedToolDefs', () => {
  it('produces namespaced wrapper defs', () => {
    const cfg: SubMcpServerConfig = {
      id: 'x',
      name: 'gws',
      displayName: 'GWS',
      baseUrl: 'https://gws.test',
      authMode: 'service_bearer',
      authConfig: {},
      enabled: true,
      serviceToken: 't',
      toolsCache: [
        { name: 'calendar.list', description: 'List events', inputSchema: { type: 'object' } },
        { name: 'Bad Name!!' }, // invalid → skipped
      ],
      toolsCachedAt: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    const { defs, skipped } = buildForwardedToolDefs(cfg);
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe('gws.calendar.list');
    expect(defs[0]?.remoteName).toBe('calendar.list');
    expect(defs[0]?.subMcpName).toBe('gws');
    expect(skipped).toEqual(['gws.Bad Name!!']);
  });
});

// ===========================================================================
// /internal/v1/credentials/resolve route
// ===========================================================================

function makeCredentialsService(opts: {
  expected: { provider: string; label?: string; userId: string; secret: string };
  prfRequired?: boolean;
}): CredentialsService {
  return {
    async create() {
      throw new Error('not used');
    },
    async read() {
      throw new Error('not used');
    },
    async list() {
      return [];
    },
    async rotate() {},
    async delete() {},
    async resolveForSubMcp(args) {
      if (opts.prfRequired && !args.prfOutput) {
        throw new PrfRequiredError(null);
      }
      if (
        args.userId !== opts.expected.userId ||
        args.provider !== opts.expected.provider ||
        (args.label ?? 'default') !== (opts.expected.label ?? 'default')
      ) {
        const e = new Error('not_found');
        Object.assign(e, { code: 'not_found' });
        throw e;
      }
      return { secret: opts.expected.secret, expiresAt: 999 };
    },
  };
}

describe('POST /internal/v1/credentials/resolve', () => {
  function buildApp(deps: {
    rows: SubMcpRow[];
    plainToken: string;
    credentials: CredentialsService;
  }) {
    const { db } = (() => {
      const r = makeStubDb(deps.rows);
      // wir wollen die `rows`-Referenz wiederverwenden
      r.rows.push(...deps.rows.filter((rr) => !r.rows.includes(rr)));
      return r;
    })();
    // simpler: makeStubDb mit den rows direkt
    const stub = makeStubDb();
    for (const r of deps.rows) stub.rows.push(r);
    const server = makeServer(stub.db);
    const registry = createSubMcpRegistry({
      db: stub.db,
      serviceTokenResolver: (n) => (n === 'gws' ? deps.plainToken : null),
    });
    const app = new Hono();
    app.onError(errorHandler());
    app.route(
      '/',
      internalCredentialsRoutes({
        server,
        credentials: deps.credentials,
        registry,
      }),
    );
    return { app, server, registry };
  }

  it('happy path: valid service-token + user-jwt → returns access_token', async () => {
    const plain = 'st-gws-secret';
    const row: SubMcpRow = {
      id: 'id-1',
      name: 'gws',
      display_name: 'GWS',
      base_url: 'https://gws.test',
      auth_mode: 'service_bearer',
      auth_config: { service_token_hash: hashServiceToken(plain) },
      enabled: true,
      tools_cache: null,
      tools_cached_at: null,
      created_at: 1,
      updated_at: 1,
    };
    const userId = '00000000-0000-0000-0000-000000000001';
    const credentials = makeCredentialsService({
      expected: { provider: 'gws', label: 'work', userId, secret: 'access-tok-xyz' },
    });
    const { app, server } = buildApp({ rows: [row], plainToken: plain, credentials });
    const jwt = await makeUserJwt(userId, 'gws', server.config);
    const res = await app.request('/internal/v1/credentials/resolve', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-service-token': plain,
      },
      body: JSON.stringify({
        user_jwt: jwt,
        provider: 'gws',
        label: 'work',
        sub_mcp_name: 'gws',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; token_type: string; expires_at: number | null };
    expect(body.access_token).toBe('access-tok-xyz');
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_at).toBe(999);
  });

  it('rejects with 401 when service-token is wrong', async () => {
    const plain = 'st-gws-secret';
    const row: SubMcpRow = {
      id: 'id-1',
      name: 'gws',
      display_name: 'GWS',
      base_url: 'https://gws.test',
      auth_mode: 'service_bearer',
      auth_config: { service_token_hash: hashServiceToken(plain) },
      enabled: true,
      tools_cache: null,
      tools_cached_at: null,
      created_at: 1,
      updated_at: 1,
    };
    const userId = '00000000-0000-0000-0000-000000000001';
    const credentials = makeCredentialsService({
      expected: { provider: 'gws', userId, secret: 'x' },
    });
    const { app, server } = buildApp({ rows: [row], plainToken: plain, credentials });
    const jwt = await makeUserJwt(userId, 'gws', server.config);
    const res = await app.request('/internal/v1/credentials/resolve', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-service-token': 'WRONG',
      },
      body: JSON.stringify({ user_jwt: jwt, provider: 'gws', sub_mcp_name: 'gws' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects when user-jwt aud does not match sub_mcp_name', async () => {
    const plain = 'st-secret';
    const row: SubMcpRow = {
      id: 'id-1',
      name: 'gws',
      display_name: 'GWS',
      base_url: 'https://gws.test',
      auth_mode: 'service_bearer',
      auth_config: { service_token_hash: hashServiceToken(plain) },
      enabled: true,
      tools_cache: null,
      tools_cached_at: null,
      created_at: 1,
      updated_at: 1,
    };
    const credentials = makeCredentialsService({
      expected: { provider: 'gws', userId: 'u', secret: 'x' },
    });
    const { app, server } = buildApp({ rows: [row], plainToken: plain, credentials });
    const jwt = await makeUserJwt('00000000-0000-0000-0000-000000000001', 'OTHER-AUD', server.config);
    const res = await app.request('/internal/v1/credentials/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': plain },
      body: JSON.stringify({ user_jwt: jwt, provider: 'gws', sub_mcp_name: 'gws' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 428 when credential needs PRF and prf_session_id missing', async () => {
    const plain = 'st-secret';
    const row: SubMcpRow = {
      id: 'id-1',
      name: 'gws',
      display_name: 'GWS',
      base_url: 'https://gws.test',
      auth_mode: 'service_bearer',
      auth_config: { service_token_hash: hashServiceToken(plain) },
      enabled: true,
      tools_cache: null,
      tools_cached_at: null,
      created_at: 1,
      updated_at: 1,
    };
    const userId = '00000000-0000-0000-0000-000000000001';
    const credentials = makeCredentialsService({
      expected: { provider: 'gws', userId, secret: 'x' },
      prfRequired: true,
    });
    const { app, server } = buildApp({ rows: [row], plainToken: plain, credentials });
    const jwt = await makeUserJwt(userId, 'gws', server.config);
    const res = await app.request('/internal/v1/credentials/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': plain },
      body: JSON.stringify({ user_jwt: jwt, provider: 'gws', sub_mcp_name: 'gws' }),
    });
    expect(res.status).toBe(428);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('prf_required');
  });
});

// ensure sha256 helper smoke
describe('hashServiceToken', () => {
  it('matches node:crypto sha256', () => {
    const tok = 'hello';
    const expected = createHash('sha256').update(tok).digest('hex');
    expect(hashServiceToken(tok)).toBe(expected);
  });
});
