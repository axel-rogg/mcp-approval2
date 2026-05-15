/**
 * Tests fuer /admin/kc-proxy/* — PWA-to-KC2-Forwarding.
 *
 * Plan-Ref: PLAN-as3-autonomous.md §1.3 (A4).
 *
 * Scope:
 *   - 401 ohne Session
 *   - Service-Token-Bearer + X-On-Behalf-Of-Header on forward
 *   - Pfad-Whitelist (/v1/, /admin/) — andere → 404
 *   - Set-Cookie Header werden NICHT durchgereicht
 *   - Query-String Pass-Through
 *   - Body Pass-Through (POST/PATCH)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { JwtSigner } from '@mcp-approval2/adapters';
import type { AppConfig } from '../lib/config.js';
import type { AppBindings, ServerContext } from '../lib/context.js';
import { kcProxyRoutes } from './kc-proxy.js';
import { issueSessionJwt } from '../auth/session/issuer.js';
import { errorHandler } from '../middleware/error-handler.js';

const USER_ID = '11111111-2222-3333-4444-555555555555';

function makeStubConfig(): AppConfig {
  return {
    NODE_ENV: 'test',
    PORT: 0,
    ORIGIN: 'https://approval2.example.test',
    DATABASE_URL: 'postgres://stub',
    DATABASE_DIALECT: 'postgres',
    JWT_SECRET: 'x'.repeat(48),
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
    GOOGLE_ALLOWED_AUDIENCES: [],
  };
}

function makeServer(): ServerContext {
  // Wir brauchen hier kein echtes db — kc-proxy nutzt nur server.config.
  return { config: makeStubConfig(), db: {} as unknown as ServerContext['db'] };
}

function makeStubSigner(oboToken = 'obo-jwt-xyz'): JwtSigner & {
  oboMock: ReturnType<typeof vi.fn>;
} {
  const oboMock = vi.fn().mockResolvedValue(oboToken);
  return {
    sign: vi.fn().mockResolvedValue('unused'),
    signOBO: oboMock,
    oboMock,
  };
}

async function buildApp(opts: {
  fetchImpl: typeof fetch;
  signer?: JwtSigner;
}): Promise<{ app: Hono<AppBindings>; cfg: AppConfig }> {
  const server = makeServer();
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'test-req');
    await next();
  });
  app.onError(errorHandler());
  app.route(
    '/',
    kcProxyRoutes(server, {
      knowledgeUrl: 'https://knowledge.example.test',
      serviceToken: 'svc-token-abc-1234567890abcdef',
      fetchImpl: opts.fetchImpl,
      ...(opts.signer ? { signerOverride: opts.signer } : {}),
    }),
  );
  return { app, cfg: server.config };
}

async function makeBearer(cfg: AppConfig): Promise<string> {
  const { token } = await issueSessionJwt(
    { userId: USER_ID, email: 'axel@example.org', role: 'member', sessionId: 'sess-1' },
    cfg,
  );
  return token;
}

describe('kc-proxy — auth', () => {
  it('returns 401 without session cookie or Bearer header', async () => {
    const fetchMock = vi.fn();
    const { app } = await buildApp({ fetchImpl: fetchMock as unknown as typeof fetch });
    const res = await app.request('/admin/kc-proxy/v1/objects', { method: 'GET' });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts Bearer session JWT', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"items":[]}', { status: 200 }));
    const { app, cfg } = await buildApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
      signer: makeStubSigner(),
    });
    const bearer = await makeBearer(cfg);
    const res = await app.request('/admin/kc-proxy/v1/objects', {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('kc-proxy — forwarding', () => {
  it('forwards GET to KC2 with service-token Bearer + X-On-Behalf-Of', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"items":[]}', { status: 200 }));
    const signer = makeStubSigner('obo-jwt-test');
    const { app, cfg } = await buildApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
      signer,
    });
    const bearer = await makeBearer(cfg);
    await app.request('/admin/kc-proxy/v1/objects?kind=doc&limit=10', {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}` },
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://knowledge.example.test/v1/objects?kind=doc&limit=10');
    expect(init?.method).toBe('GET');
    const headers = init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer svc-token-abc-1234567890abcdef');
    expect(headers['x-on-behalf-of']).toBe('obo-jwt-test');

    // OBO-Signer-Call:
    expect(signer.oboMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: USER_ID,
        aud: 'mcp-knowledge2',
        on_behalf_of: 'axel@example.org',
        ttlSec: 60,
      }),
    );
  });

  it('forwards POST body to KC2', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"id":"o1"}', { status: 201 }));
    const { app, cfg } = await buildApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
      signer: makeStubSigner(),
    });
    const bearer = await makeBearer(cfg);
    const body = JSON.stringify({ kind: 'doc', title: 'hello' });
    const res = await app.request('/admin/kc-proxy/v1/objects', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
      },
      body,
    });
    expect(res.status).toBe(201);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(body);
    const headers = init?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
  });

  it('strips set-cookie from KC2 response', async () => {
    const respHeaders = new Headers({ 'content-type': 'application/json' });
    respHeaders.set('set-cookie', 'kc_evil=1');
    respHeaders.set('x-keep', 'yes');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}', { status: 200, headers: respHeaders }));
    const { app, cfg } = await buildApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
      signer: makeStubSigner(),
    });
    const bearer = await makeBearer(cfg);
    const res = await app.request('/admin/kc-proxy/v1/objects', {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-keep')).toBe('yes');
  });

  it('rejects non-whitelisted paths with 404', async () => {
    const fetchMock = vi.fn();
    const { app, cfg } = await buildApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
      signer: makeStubSigner(),
    });
    const bearer = await makeBearer(cfg);
    const res = await app.request('/admin/kc-proxy/weird/path', {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects path-traversal with 400', async () => {
    const fetchMock = vi.fn();
    const { app, cfg } = await buildApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
      signer: makeStubSigner(),
    });
    const bearer = await makeBearer(cfg);
    const res = await app.request('/admin/kc-proxy/v1/../../etc/passwd', {
      headers: { authorization: `Bearer ${bearer}` },
    });
    // Pfad wird durch URL-Parsing in Hono evtl. normalisiert; wir akzeptieren 400 oder 404.
    expect([400, 404]).toContain(res.status);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps upstream fetch network-error to 502', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('boom'));
    const { app, cfg } = await buildApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
      signer: makeStubSigner(),
    });
    const bearer = await makeBearer(cfg);
    const res = await app.request('/admin/kc-proxy/v1/objects', {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.status).toBe(502);
  });

  it('handles 204 from KC2 (DELETE)', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const { app, cfg } = await buildApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
      signer: makeStubSigner(),
    });
    const bearer = await makeBearer(cfg);
    const res = await app.request('/admin/kc-proxy/v1/objects/o1', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.status).toBe(204);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });
});
