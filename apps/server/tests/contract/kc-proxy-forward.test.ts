/**
 * Cross-Service Contract-Test (T3-2 approval2-side): kc-proxy → KC2 forwarding.
 *
 * Plan-Ref: PLAN-as3-autonomous.md §1.3 + §2.3 + §2.1 (OBO-JWT shape).
 *
 * Same-Origin PWA-Calls (`/admin/kc-proxy/*`) MUST emerge from approval2 with
 * the contract shape KC2 expects on its REST + MCP boundary:
 *
 *   Authorization: Bearer <SERVICE_TOKEN>         ← KC2 require_jwt_or_obo
 *   X-On-Behalf-Of:  <OBO-JWT>                    ← signed by approval2's facade
 *   X-Request-Id:    <UUID>
 *
 * Same OBO-JWT shape that KC2's tests/contract/obo-jwt.test.ts asserts on
 * the consumer side. This file enforces it on the producer side.
 *
 * Path-Whitelist invariant: only /v1/* and /admin/* are proxyable. Anything
 * else is 404 (defense-in-depth against SSRF from PWA-JS).
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { JwtSigner } from '@mcp-approval2/adapters';
import type { AppConfig } from '../../src/lib/config.js';
import type { AppBindings, ServerContext } from '../../src/lib/context.js';
import { kcProxyRoutes } from '../../src/routes/kc-proxy.js';
import { issueSessionJwt } from '../../src/auth/session/issuer.js';
import { errorHandler } from '../../src/middleware/error-handler.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const USER_EMAIL = 'axel@example.org';
const SERVICE_TOKEN = 'svc-token-abc-1234567890abcdefghi';

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
  return { config: makeStubConfig(), db: {} as unknown as ServerContext['db'] };
}

function makeRecordingSigner(returnsObo = 'obo-jwt-string-x'): JwtSigner & {
  oboCalls: ReturnType<typeof vi.fn>;
} {
  const oboCalls = vi.fn().mockResolvedValue(returnsObo);
  return {
    sign: vi.fn().mockResolvedValue('unused'),
    signOBO: oboCalls,
    oboCalls,
  };
}

async function buildApp(opts: { fetchImpl: typeof fetch; signer?: JwtSigner }) {
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
      serviceToken: SERVICE_TOKEN,
      fetchImpl: opts.fetchImpl,
      ...(opts.signer ? { signerOverride: opts.signer } : {}),
    }),
  );
  return { app, cfg: server.config };
}

async function makeBearer(cfg: AppConfig): Promise<string> {
  const { token } = await issueSessionJwt(
    { userId: USER_ID, email: USER_EMAIL, role: 'member', sessionId: 'sess-1' },
    cfg,
  );
  return token;
}

// ─── OBO-JWT signing args (mirror of KC2-side obo-jwt.test.ts) ─────────────

describe('kc-proxy — OBO-JWT signing args (cross-service contract)', () => {
  it('passes sub + aud + on_behalf_of + request_id to the signer', async () => {
    const signer = makeRecordingSigner();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const { app, cfg } = await buildApp({ fetchImpl: fetchMock as unknown as typeof fetch, signer });
    const bearer = await makeBearer(cfg);

    await app.request('http://approval2.test/admin/kc-proxy/v1/objects', {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(signer.oboCalls).toHaveBeenCalledTimes(1);
    const [args] = signer.oboCalls.mock.calls[0] as [Record<string, unknown>];
    // These four claims are the cross-service contract baseline.
    expect(args).toMatchObject({
      sub: USER_ID,
      aud: 'mcp-knowledge2',
      on_behalf_of: USER_EMAIL,
    });
    expect(args).toHaveProperty('request_id');
    expect(typeof args.request_id).toBe('string');
    // Lifetime is short (PWA-Pfad uses 60s by default — see kc-proxy.ts).
    expect(typeof args.ttlSec).toBe('number');
    expect((args.ttlSec as number) <= 120).toBe(true);
  });

  it('propagates X-Request-Id from PWA → OBO claim → outbound header', async () => {
    const signer = makeRecordingSigner();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const { app, cfg } = await buildApp({ fetchImpl: fetchMock as unknown as typeof fetch, signer });
    const bearer = await makeBearer(cfg);
    const reqId = '00000000-0000-0000-0000-0000beadface0';

    await app.request('http://approval2.test/admin/kc-proxy/v1/objects', {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}`, 'x-request-id': reqId },
    });
    // Claim:
    const [oboArgs] = signer.oboCalls.mock.calls[0] as [Record<string, unknown>];
    expect(oboArgs.request_id).toBe(reqId);
    // Outbound header:
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const h = init.headers as Record<string, string>;
    expect(h['x-request-id']).toBe(reqId);
  });
});

// ─── HTTP-Header contract (mirror of KC2-side header verification) ─────────

describe('kc-proxy — HTTP-Header contract (KC2-side require_jwt_or_obo)', () => {
  it('emits exactly: Authorization=Bearer SERVICE_TOKEN + X-On-Behalf-Of=<JWT>', async () => {
    const signer = makeRecordingSigner('obo-token-xyz-abc');
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const { app, cfg } = await buildApp({ fetchImpl: fetchMock as unknown as typeof fetch, signer });
    const bearer = await makeBearer(cfg);

    await app.request('http://approval2.test/admin/kc-proxy/v1/objects/123', {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}` },
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const h = init.headers as Record<string, string>;
    expect(h['authorization']).toBe(`Bearer ${SERVICE_TOKEN}`);
    expect(h['x-on-behalf-of']).toBe('obo-token-xyz-abc');
  });

  it('does NOT forward the PWA Bearer (user-JWT must not reach KC2)', async () => {
    const signer = makeRecordingSigner();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const { app, cfg } = await buildApp({ fetchImpl: fetchMock as unknown as typeof fetch, signer });
    const bearer = await makeBearer(cfg);

    await app.request('http://approval2.test/admin/kc-proxy/v1/objects', {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}` },
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const h = init.headers as Record<string, string>;
    expect(h['authorization']).not.toBe(`Bearer ${bearer}`); // User-JWT replaced
    expect(h['authorization']).toBe(`Bearer ${SERVICE_TOKEN}`);
  });

  it('does NOT smuggle PWA headers (cookie/origin/host) through to KC2', async () => {
    const signer = makeRecordingSigner();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const { app, cfg } = await buildApp({ fetchImpl: fetchMock as unknown as typeof fetch, signer });
    const bearer = await makeBearer(cfg);

    await app.request('http://approval2.test/admin/kc-proxy/v1/objects', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${bearer}`,
        cookie: 'session_jwt=stolen',
        origin: 'https://evil.test',
        host: 'evil.test',
      },
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const h = init.headers as Record<string, string>;
    expect(h['cookie']).toBeUndefined();
    expect(h['origin']).toBeUndefined();
    expect(h['host']).toBeUndefined();
  });
});

// ─── Path-Whitelist contract ──────────────────────────────────────────────

describe('kc-proxy — path-whitelist (anti-SSRF)', () => {
  it('accepts /v1/* paths', async () => {
    const signer = makeRecordingSigner();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const { app, cfg } = await buildApp({ fetchImpl: fetchMock as unknown as typeof fetch, signer });
    const bearer = await makeBearer(cfg);
    const res = await app.request('http://approval2.test/admin/kc-proxy/v1/objects/abc', {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('accepts /admin/* paths (KC2-side admin routes are also proxyable)', async () => {
    const signer = makeRecordingSigner();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const { app, cfg } = await buildApp({ fetchImpl: fetchMock as unknown as typeof fetch, signer });
    const bearer = await makeBearer(cfg);
    const res = await app.request('http://approval2.test/admin/kc-proxy/admin/something', {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects /mcp prefix — Claude.ai-MCP-Endpoint must NOT be proxyable from PWA', async () => {
    // KC2's /mcp is the autonomous-path MCP endpoint. PWA proxying that
    // would bypass approval2's tool-surface + approval flow. Defense-in-depth.
    const signer = makeRecordingSigner();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const { app, cfg } = await buildApp({ fetchImpl: fetchMock as unknown as typeof fetch, signer });
    const bearer = await makeBearer(cfg);
    const res = await app.request('http://approval2.test/admin/kc-proxy/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}` },
      body: '{}',
    });
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects path-traversal /v1/../etc', async () => {
    const signer = makeRecordingSigner();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const { app, cfg } = await buildApp({ fetchImpl: fetchMock as unknown as typeof fetch, signer });
    const bearer = await makeBearer(cfg);
    const res = await app.request('http://approval2.test/admin/kc-proxy/v1/../etc', {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}` },
    });
    // Hono normalises paths; if it survives to handler, traversal check rejects.
    expect([400, 404]).toContain(res.status);
  });
});

// ─── Response-headers contract (PWA-side safety) ──────────────────────────

describe('kc-proxy — response-header contract (no KC2-cookie leak)', () => {
  it('strips set-cookie from upstream response (cookie-domain mismatch protection)', async () => {
    const signer = makeRecordingSigner();
    const upstream = new Response('{}', {
      status: 200,
      headers: {
        'set-cookie': 'kc2_sess=abc; Domain=knowledge.example.test',
        'content-type': 'application/json',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(upstream);
    const { app, cfg } = await buildApp({ fetchImpl: fetchMock as unknown as typeof fetch, signer });
    const bearer = await makeBearer(cfg);
    const res = await app.request('http://approval2.test/admin/kc-proxy/v1/objects', {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
