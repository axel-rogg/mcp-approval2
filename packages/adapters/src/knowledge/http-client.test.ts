/**
 * HttpKnowledgeAdapter tests — mocked fetch + JwtSigner.
 *
 * Wire-Shapes spiegeln den Server-Code in /workspaces/mcp-knowledge2 wider:
 *   - createObject: `body_b64` (base64), `mime_type`, `filename`, `embed`
 *   - listObjects: `{items, next_cursor}` (int cursor, nicht hasMore)
 *   - createShare: `{granted_to, scope, expires_at?}` snake_case (kein resourceKind)
 *   - listShares: `{items: [...]}` (kein bare array)
 *   - search: `{subtypes: string[]}` (kind-agnostisch, ADR-0004)
 *   - eraseUser: `{user_id, confirmation_token}` + Service-Token + rich response
 *   - getObject: optional `?expand=body` → body_b64-Field
 *   - Errors: RFC 7807 Problem Details (mit Legacy-Fallback)
 */
import { describe, it, expect, vi } from 'vitest';
import { HttpKnowledgeAdapter, type JwtSigner, type FetchLike } from './http-client.js';
import {
  AuthError,
  ConflictError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ServiceError,
  ValidationError,
} from './errors.js';

const USER_ID = '00000000-0000-0000-0000-000000000001';

function makeSigner(
  token = 'jwt-token-xyz',
  oboToken = 'obo-jwt-token-xyz',
): JwtSigner & {
  signMock: ReturnType<typeof vi.fn>;
  oboMock: ReturnType<typeof vi.fn>;
  /** Legacy alias to keep older test expectations stable. */
  mock: ReturnType<typeof vi.fn>;
} {
  const signMock = vi.fn().mockResolvedValue(token);
  const oboMock = vi.fn().mockResolvedValue(oboToken);
  return { sign: signMock, signOBO: oboMock, signMock, oboMock, mock: signMock };
}

function makeJsonResponse(status: number, body: unknown, init?: { requestId?: string }): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init?.requestId) headers.set('x-request-id', init.requestId);
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers,
  });
}

function makeProblemResponse(
  status: number,
  problem: { type?: string; title: string; detail?: string; instance?: string; [k: string]: unknown },
  init?: { requestId?: string },
): Response {
  const headers = new Headers({ 'content-type': 'application/problem+json' });
  if (init?.requestId) headers.set('x-request-id', init.requestId);
  return new Response(JSON.stringify({ status, ...problem }), {
    status,
    headers,
  });
}

function defaultObjectView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // ObjectView wie der Server sie schickt (camelCase, alle Pflichtfelder).
  // ADR-0004: kein `kind` mehr, nur free-form `subtype`.
  return {
    id: 'o1',
    ownerId: USER_ID,
    subtype: null,
    title: null,
    description: null,
    keywords: null,
    triggerHints: null,
    meta: null,
    bodySize: 0,
    bodyHash: null,
    mimeType: null,
    filename: null,
    visibility: 'private',
    pinned: false,
    archived: false,
    refcount: 0,
    currentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    ...overrides,
  };
}

function makeAdapter(opts: {
  fetchImpl: FetchLike;
  signer?: JwtSigner;
  baseUrl?: string;
  jwtTtlSec?: number;
  serviceToken?: string;
}): HttpKnowledgeAdapter {
  return new HttpKnowledgeAdapter({
    baseUrl: opts.baseUrl ?? 'https://knowledge.example.org',
    jwtSigner: opts.signer ?? makeSigner(),
    fetchImpl: opts.fetchImpl,
    ...(opts.jwtTtlSec !== undefined ? { jwtTtlSec: opts.jwtTtlSec } : {}),
    ...(opts.serviceToken !== undefined ? { serviceToken: opts.serviceToken } : {}),
    requestIdFactory: () => 'req-test-1',
  });
}

describe('HttpKnowledgeAdapter — authedFetch + JWT', () => {
  it('signs JWT with userId as sub and ttl, forwards as Bearer', async () => {
    const signer = makeSigner('signed-jwt-abc');
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, defaultObjectView()),
    );

    const adapter = makeAdapter({ fetchImpl: fetchMock, signer });
    await adapter.getObject({ id: 'o1', userId: USER_ID });

    expect(signer.mock).toHaveBeenCalledTimes(1);
    expect(signer.mock).toHaveBeenCalledWith({
      sub: USER_ID,
      ttlSec: 60,
      scope: 'objects:read',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://knowledge.example.org/v1/objects/o1');
    const headers = init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer signed-jwt-abc');
    expect(headers['x-request-id']).toBe('req-test-1');
    expect(init?.method).toBe('GET');
  });

  it('respects custom jwtTtlSec', async () => {
    const signer = makeSigner();
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, { items: [], next_cursor: null }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock, signer, jwtTtlSec: 30 });
    await adapter.listObjects({ userId: USER_ID });
    expect(signer.mock).toHaveBeenCalledWith({ sub: USER_ID, ttlSec: 30, scope: 'objects:read' });
  });

  it('sends Content-Type + JSON body on POST', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, defaultObjectView()),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.createObject({
      userId: USER_ID,
      subtype: 'doc',
      title: 'hello',
      body: 'hello-body',
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = init?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(init?.method).toBe('POST');
    const sent = JSON.parse(init?.body as string) as Record<string, unknown>;
    // ADR-0004: kein `kind` mehr im Wire-Body.
    expect(sent['kind']).toBeUndefined();
    expect(sent['subtype']).toBe('doc');
    expect(sent['title']).toBe('hello');
    // D-2: body wird base64-encodet als body_b64 gesendet, NICHT als body.
    expect(sent['body']).toBeUndefined();
    expect(sent['body_b64']).toBe(Buffer.from('hello-body', 'utf-8').toString('base64'));
  });

  it('omits Content-Type for GET (no body)', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, { items: [], next_cursor: null }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.listObjects({ userId: USER_ID });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = init?.headers as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
  });

  it('strips trailing slash from baseUrl', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, defaultObjectView()),
    );
    const adapter = makeAdapter({
      fetchImpl: fetchMock,
      baseUrl: 'https://knowledge.example.org///',
    });
    await adapter.getObject({ id: 'o1', userId: USER_ID });
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://knowledge.example.org/v1/objects/o1');
  });

  it('throws if baseUrl is empty', () => {
    expect(
      () =>
        new HttpKnowledgeAdapter({
          baseUrl: '',
          jwtSigner: makeSigner(),
          fetchImpl: vi.fn() as unknown as FetchLike,
        }),
    ).toThrow(/baseUrl required/);
  });
});

describe('HttpKnowledgeAdapter — error mapping (RFC 7807)', () => {
  it.each([
    [400, ValidationError],
    [401, AuthError],
    [403, PermissionError],
    [404, NotFoundError],
    [409, ConflictError],
    [429, RateLimitError],
    [500, ServiceError],
    [502, ServiceError],
    [503, ServiceError],
  ])('maps HTTP %i to correct error class (problem-detail)', async (status, Cls) => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeProblemResponse(status, {
        type: `https://problems.knowledge2/x-${status}`,
        title: `boom ${status}`,
        detail: 'more',
      }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await expect(adapter.getObject({ id: 'o1', userId: USER_ID })).rejects.toBeInstanceOf(Cls);
  });

  it('still parses legacy {error:{code,message}} body', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(403, {
        error: { code: 'forbidden', message: 'not your doc', details: { docId: 'o1' } },
      }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await expect(adapter.getObject({ id: 'o1', userId: USER_ID })).rejects.toMatchObject({
      status: 403,
      message: 'not your doc',
      details: { docId: 'o1' },
    });
  });

  it('extracts code from RFC-7807 type-URI suffix', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeProblemResponse(429, {
        type: 'https://problems.knowledge2/quota-exceeded',
        title: 'Daily embed quota exhausted',
      }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    try {
      await adapter.getObject({ id: 'o1', userId: USER_ID });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).code).toBe('quota-exceeded');
      expect((err as RateLimitError).message).toBe('Daily embed quota exhausted');
    }
  });

  it('combines title + detail into message', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeProblemResponse(400, {
        type: 'https://problems.knowledge2/bad-request',
        title: 'invalid input',
        detail: 'body_b64 too long',
      }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await expect(adapter.getObject({ id: 'o1', userId: USER_ID })).rejects.toMatchObject({
      status: 400,
      message: 'invalid input: body_b64 too long',
    });
  });

  it('lifts problem.instance into requestId (server-set correlation)', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeProblemResponse(404, {
        type: 'https://problems.knowledge2/not-found',
        title: 'missing',
        instance: 'srv-req-42',
      }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    try {
      await adapter.getObject({ id: 'o1', userId: USER_ID });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).requestId).toBe('srv-req-42');
    }
  });

  it('falls back to plain-text body when not JSON', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      new Response('upstream is on fire', { status: 502 }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await expect(adapter.getObject({ id: 'o1', userId: USER_ID })).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('upstream is on fire') as unknown as string,
    });
  });

  it('extracts x-request-id from response header fallback', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(
        404,
        { error: { code: 'not_found', message: 'missing' } },
        { requestId: 'hdr-req-99' },
      ),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    try {
      await adapter.getObject({ id: 'o1', userId: USER_ID });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).requestId).toBe('hdr-req-99');
    }
  });

  it('wraps network errors as ServiceError', async () => {
    const fetchMock = vi.fn<FetchLike>().mockRejectedValue(new TypeError('fetch failed'));
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await expect(adapter.getObject({ id: 'o1', userId: USER_ID })).rejects.toMatchObject({
      name: 'ServiceError',
      status: 502,
      message: expect.stringContaining('fetch failed') as unknown as string,
    });
  });

  it('throws ServiceError on invalid JSON in success body', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      new Response('this is not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await expect(adapter.getObject({ id: 'o1', userId: USER_ID })).rejects.toMatchObject({
      name: 'ServiceError',
      status: 502,
    });
  });

  it('returns void on 204 No Content', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(new Response(null, { status: 204 }));
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await expect(adapter.deleteObject({ id: 'o1', userId: USER_ID })).resolves.toBeUndefined();
  });
});

describe('HttpKnowledgeAdapter — createObject (D-2 + D-3)', () => {
  it('serializes Uint8Array body as base64 body_b64', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(201, defaultObjectView()),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    await adapter.createObject({
      userId: USER_ID,
      subtype: 'doc',
      body: bytes,
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const sent = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(sent['body_b64']).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('forwards mime_type/filename/embed as snake_case (D-3)', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(201, defaultObjectView()),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.createObject({
      userId: USER_ID,
      subtype: 'doc',
      title: 'T',
      description: 'D',
      keywords: ['a', 'b'],
      triggerHints: 'h',
      meta: { foo: 1 },
      body: 'body-text',
      mimeType: 'text/plain',
      filename: 'note.txt',
      embed: true,
      visibility: 'private',
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const sent = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({
      subtype: 'doc',
      title: 'T',
      description: 'D',
      keywords: ['a', 'b'],
      trigger_hints: 'h',
      meta: { foo: 1 },
      mime_type: 'text/plain',
      filename: 'note.txt',
      embed: true,
      visibility: 'private',
    });
    expect(sent['kind']).toBeUndefined();
    expect(sent['body_b64']).toBe(Buffer.from('body-text', 'utf-8').toString('base64'));
  });
});

describe('HttpKnowledgeAdapter — getObject (D-11)', () => {
  it('omits expand-param by default', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, defaultObjectView()),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.getObject({ id: 'o1', userId: USER_ID });
    const [url] = fetchMock.mock.calls[0] ?? [];
    const u = new URL(String(url));
    expect(u.searchParams.get('expand')).toBeNull();
  });

  it('sends ?expand=body when expandBody=true', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, {
        ...defaultObjectView(),
        body_b64: Buffer.from('hello', 'utf-8').toString('base64'),
      }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    const obj = await adapter.getObject({ id: 'o1', userId: USER_ID, expandBody: true });
    const [url] = fetchMock.mock.calls[0] ?? [];
    const u = new URL(String(url));
    expect(u.searchParams.get('expand')).toBe('body');
    // body_b64 wird in body lifted (caller decoded selbst)
    expect(obj.body).toBe(Buffer.from('hello', 'utf-8').toString('base64'));
  });

  it('omits body field when server did not return body_b64', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, defaultObjectView()),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    const obj = await adapter.getObject({ id: 'o1', userId: USER_ID });
    expect(obj.body).toBeUndefined();
  });

  // ─── PLAN-document-linking §10.5 D1: refs roundtrip ───────────────────
  it('sends ?refs_limit=N when refsLimit provided', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, defaultObjectView()),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.getObject({ id: 'o1', userId: USER_ID, refsLimit: 3 });
    const [url] = fetchMock.mock.calls[0] ?? [];
    const u = new URL(String(url));
    expect(u.searchParams.get('refs_limit')).toBe('3');
  });

  it('sends ?refs_limit=0 to suppress refs', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, defaultObjectView()),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.getObject({ id: 'o1', userId: USER_ID, refsLimit: 0 });
    const [url] = fetchMock.mock.calls[0] ?? [];
    const u = new URL(String(url));
    expect(u.searchParams.get('refs_limit')).toBe('0');
  });

  it('omits refs_limit param when refsLimit undefined (KC2-default 5 applies)', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, defaultObjectView()),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.getObject({ id: 'o1', userId: USER_ID });
    const [url] = fetchMock.mock.calls[0] ?? [];
    const u = new URL(String(url));
    expect(u.searchParams.get('refs_limit')).toBeNull();
  });

  it('passes through refs structure from KC2 response (Wire-Format-Snapshot)', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, {
        ...defaultObjectView(),
        refs: {
          outgoing: [
            {
              role: 'resource',
              id: '01J11111-1111-1111-1111-111111111111',
              subtype: 'doc',
              title: 'API-Reference',
              summary: 'pdfplumber + PyPDF2 API',
              uri: 'kc://object/01J11111-1111-1111-1111-111111111111',
            },
          ],
          incoming: [],
          truncated: { outgoing: false, incoming: false },
        },
      }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    const obj = await adapter.getObject({ id: 'o1', userId: USER_ID });
    expect(obj.refs).toBeDefined();
    expect(obj.refs?.outgoing).toHaveLength(1);
    expect(obj.refs?.outgoing[0]?.role).toBe('resource');
    expect(obj.refs?.outgoing[0]?.uri).toBe(
      'kc://object/01J11111-1111-1111-1111-111111111111',
    );
    expect(obj.refs?.outgoing[0]?.summary).toBe('pdfplumber + PyPDF2 API');
    expect(obj.refs?.truncated.outgoing).toBe(false);
  });

  it('isSubdoc passes through from KC2 response', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, { ...defaultObjectView(), isSubdoc: true }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    const obj = await adapter.getObject({ id: 'o1', userId: USER_ID });
    expect(obj.isSubdoc).toBe(true);
  });

  // ─── PLAN-document-linking §9 P9: includeRefBodies eager-embed ────────
  it('sends ?include_bodies=resource as CSV when includeRefBodies provided', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, defaultObjectView()),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.getObject({
      id: 'o1',
      userId: USER_ID,
      includeRefBodies: ['resource'],
    });
    const [url] = fetchMock.mock.calls[0] ?? [];
    const u = new URL(String(url));
    expect(u.searchParams.get('include_bodies')).toBe('resource');
  });

  it('sends ?include_bodies=resource,depends_on (multi-role CSV)', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, defaultObjectView()),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.getObject({
      id: 'o1',
      userId: USER_ID,
      includeRefBodies: ['resource', 'depends_on'],
    });
    const [url] = fetchMock.mock.calls[0] ?? [];
    const u = new URL(String(url));
    expect(u.searchParams.get('include_bodies')).toBe('resource,depends_on');
  });

  it('omits include_bodies param when array is empty', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, defaultObjectView()),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.getObject({ id: 'o1', userId: USER_ID, includeRefBodies: [] });
    const [url] = fetchMock.mock.calls[0] ?? [];
    const u = new URL(String(url));
    expect(u.searchParams.get('include_bodies')).toBeNull();
  });

  it('passes through expanded ref bodies (Wire-Format-Snapshot)', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, {
        ...defaultObjectView(),
        refs: {
          outgoing: [
            {
              role: 'resource',
              id: '01J11111-1111-1111-1111-111111111111',
              subtype: 'doc',
              title: 'API-Ref',
              summary: 'API reference',
              uri: 'kc://object/01J11111-1111-1111-1111-111111111111',
              body: 'aGVsbG8gd29ybGQ=', // base64 'hello world'
              bodyEncoding: 'base64',
            },
            {
              role: 'resource',
              id: '01J22222-2222-2222-2222-222222222222',
              subtype: 'doc',
              title: 'Big',
              summary: '...',
              uri: 'kc://object/01J22222-2222-2222-2222-222222222222',
              truncatedReason: 'oversized',
            },
          ],
          incoming: [],
          truncated: { outgoing: false, incoming: false },
        },
      }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    const obj = await adapter.getObject({
      id: 'o1',
      userId: USER_ID,
      includeRefBodies: ['resource'],
    });
    expect(obj.refs?.outgoing[0]?.body).toBe('aGVsbG8gd29ybGQ=');
    expect(obj.refs?.outgoing[0]?.bodyEncoding).toBe('base64');
    expect(obj.refs?.outgoing[1]?.truncatedReason).toBe('oversized');
    expect(obj.refs?.outgoing[1]?.body).toBeUndefined();
  });
});

describe('HttpKnowledgeAdapter — listObjects (D-4 + D-5)', () => {
  it('serializes subtype/limit/cursor as query params (cursor as integer)', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, { items: [], next_cursor: null }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.listObjects({ userId: USER_ID, subtype: 'skill', limit: 50, cursor: 1234567890 });
    const [url] = fetchMock.mock.calls[0] ?? [];
    const u = new URL(String(url));
    expect(u.pathname).toBe('/v1/objects');
    // ADR-0004: kein `kind` mehr — `subtype` ist der einzige Discriminator.
    expect(u.searchParams.get('kind')).toBeNull();
    expect(u.searchParams.get('subtype')).toBe('skill');
    expect(u.searchParams.get('limit')).toBe('50');
    expect(u.searchParams.get('cursor')).toBe('1234567890');
  });

  it('maps next_cursor to nextCursor', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, {
        items: [defaultObjectView()],
        next_cursor: 9999,
      }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    const list = await adapter.listObjects({ userId: USER_ID });
    expect(list.items).toHaveLength(1);
    expect(list.nextCursor).toBe(9999);
  });

  it('returns nextCursor=null when server signals end-of-list', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, { items: [], next_cursor: null }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    const list = await adapter.listObjects({ userId: USER_ID });
    expect(list.nextCursor).toBeNull();
  });

  it('serializes subtypePrefix as ?subtype_prefix= query param', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, { items: [], next_cursor: null }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.listObjects({ userId: USER_ID, subtypePrefix: 'app:' });
    const [url] = fetchMock.mock.calls[0] ?? [];
    const u = new URL(String(url));
    expect(u.pathname).toBe('/v1/objects');
    expect(u.searchParams.get('subtype_prefix')).toBe('app:');
    // mutually exclusive — neither flag should leak the other.
    expect(u.searchParams.get('subtype')).toBeNull();
  });

  it('rejects locally when both subtype and subtypePrefix are set (mutual-excl)', async () => {
    const fetchMock = vi.fn<FetchLike>();
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await expect(
      adapter.listObjects({ userId: USER_ID, subtype: 'doc', subtypePrefix: 'app:' }),
    ).rejects.toThrowError(/mutually exclusive/);
    // No HTTP roundtrip should have happened — caught locally.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('HttpKnowledgeAdapter — updateObject', () => {
  it('uses PATCH and snake_cases known patch fields', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, defaultObjectView()),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.updateObject({
      id: 'o1',
      userId: USER_ID,
      patch: {
        title: 'new',
        triggerHints: 'h',
        expectedVersion: 3,
        reEmbed: true,
        body: 'body-text',
      },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://knowledge.example.org/v1/objects/o1');
    expect(init?.method).toBe('PATCH');
    const sent = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({
      title: 'new',
      trigger_hints: 'h',
      expected_version: 3,
      re_embed: true,
    });
    expect(sent['body_b64']).toBe(Buffer.from('body-text', 'utf-8').toString('base64'));
  });
});

describe('HttpKnowledgeAdapter — deleteObject', () => {
  it('uses DELETE + handles 204', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(new Response(null, { status: 204 }));
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.deleteObject({ id: 'o1', userId: USER_ID });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.method).toBe('DELETE');
  });
});

describe('HttpKnowledgeAdapter — createShare (D-6 + D-7)', () => {
  it('sends granted_to/scope snake_case (ADR-0004: no resourceKind on wire)', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(201, {
        id: 's1',
        resourceId: 'o1',
        grantedBy: USER_ID,
        grantedTo: 'user-2',
        scope: 'read',
        grantedAt: 1,
        expiresAt: null,
        revokedAt: null,
      }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    const share = await adapter.createShare({
      resourceId: 'o1',
      userId: USER_ID,
      grantedTo: 'user-2',
      scope: 'read',
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://knowledge.example.org/v1/objects/o1/shares');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    // ADR-0004: server-Body ohne resourceKind, snake_case granted_to.
    expect(body).toEqual({ granted_to: 'user-2', scope: 'read' });
    // D-7: server-Response hat grantedAt (nicht createdAt).
    expect(share.grantedAt).toBe(1);
  });

  it('includes expires_at when provided', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(201, {
        id: 's1',
        resourceId: 'o1',
        grantedBy: USER_ID,
        grantedTo: 'user-2',
        scope: 'read',
        grantedAt: 1,
        expiresAt: 9999,
        revokedAt: null,
      }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.createShare({
      resourceId: 'o1',
      userId: USER_ID,
      grantedTo: 'user-2',
      scope: 'read',
      expiresAt: 9999,
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({ granted_to: 'user-2', scope: 'read', expires_at: 9999 });
  });
});

describe('HttpKnowledgeAdapter — listShares (D-8)', () => {
  it('unwraps {items: [...]} envelope', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, {
        items: [
          {
            id: 's1',
            resourceId: 'o1',
            grantedBy: USER_ID,
            grantedTo: 'u2',
            scope: 'read',
            grantedAt: 1,
            expiresAt: null,
            revokedAt: null,
          },
        ],
      }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    const shares = await adapter.listShares({ resourceId: 'o1', userId: USER_ID });
    expect(shares).toHaveLength(1);
    expect(shares[0]?.id).toBe('s1');
  });
});

describe('HttpKnowledgeAdapter — revokeShare', () => {
  it('hits /v1/shares/{id} with DELETE', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(new Response(null, { status: 204 }));
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.revokeShare({ shareId: 's1', userId: USER_ID });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://knowledge.example.org/v1/shares/s1');
    expect(init?.method).toBe('DELETE');
  });
});

describe('HttpKnowledgeAdapter — search (ADR-0004 subtypes)', () => {
  it('sends subtypes array even when only one subtype is requested', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, {
        items: [
          { id: 'o1', subtype: 'doc', title: 'h', score: 0.9, ftsRank: 0.5, vectorScore: 0.4 },
        ],
      }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    const hits = await adapter.search({ userId: USER_ID, query: 'foo', subtypes: ['doc'], limit: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe('o1');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://knowledge.example.org/v1/search');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({ query: 'foo', subtypes: ['doc'], limit: 5 });
    expect(body['kind']).toBeUndefined();
  });

  it('sends multi-subtype filter as array', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, { items: [] }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.search({ userId: USER_ID, query: 'foo', subtypes: ['doc', 'skill'] });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({ query: 'foo', subtypes: ['doc', 'skill'] });
  });

  it('omits subtypes when undefined or empty', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, { items: [] }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.search({ userId: USER_ID, query: 'foo' });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({ query: 'foo' });
    expect(body['subtypes']).toBeUndefined();
    expect(body['kind']).toBeUndefined();
  });

  it('sends subtype_prefixes when provided (combinable with subtypes)', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, { items: [] }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.search({
      userId: USER_ID,
      query: 'foo',
      subtypes: ['skill'],
      subtypePrefixes: ['app:'],
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      query: 'foo',
      subtypes: ['skill'],
      subtype_prefixes: ['app:'],
    });
  });

  it('omits subtype_prefixes when undefined or empty', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, { items: [] }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.search({ userId: USER_ID, query: 'foo', subtypePrefixes: [] });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['subtype_prefixes']).toBeUndefined();
  });
});

// =============================================================================
// AS-3 Tests — OBO-Pfad
// =============================================================================

describe('HttpKnowledgeAdapter — AS-3 OBO pattern', () => {
  it('uses serviceToken + X-On-Behalf-Of header when serviceToken configured', async () => {
    const signer = makeSigner('legacy-jwt', 'obo-jwt-xyz');
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, defaultObjectView()),
    );
    const adapter = makeAdapter({
      fetchImpl: fetchMock,
      signer,
      serviceToken: 'svc-token-abc',
    });
    await adapter.getObject({
      id: 'o1',
      userId: USER_ID,
      userEmail: 'axel@example.org',
    });

    // OBO-Pfad: signer.signOBO wurde gerufen, signer.sign NICHT.
    expect(signer.oboMock).toHaveBeenCalledTimes(1);
    expect(signer.signMock).not.toHaveBeenCalled();
    expect(signer.oboMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: USER_ID,
        aud: 'mcp-knowledge2',
        on_behalf_of: 'axel@example.org',
        ttlSec: 120,
        request_id: 'req-test-1',
      }),
    );

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer svc-token-abc');
    expect(headers['x-on-behalf-of']).toBe('obo-jwt-xyz');
    expect(headers['x-request-id']).toBe('req-test-1');
  });

  it('falls back to userId as on_behalf_of when userEmail not provided', async () => {
    const signer = makeSigner();
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, defaultObjectView()),
    );
    const adapter = makeAdapter({
      fetchImpl: fetchMock,
      signer,
      serviceToken: 'svc-token',
    });
    await adapter.getObject({ id: 'o1', userId: USER_ID });
    expect(signer.oboMock).toHaveBeenCalledWith(
      expect.objectContaining({
        on_behalf_of: USER_ID, // fallback when userEmail missing
      }),
    );
  });

  it('forwards approval_id to OBO-JWT when provided (write-tools)', async () => {
    const signer = makeSigner();
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, defaultObjectView()),
    );
    const adapter = makeAdapter({
      fetchImpl: fetchMock,
      signer,
      serviceToken: 'svc-token',
    });
    await adapter.updateObject({
      id: 'o1',
      userId: USER_ID,
      userEmail: 'axel@example.org',
      approvalId: 'appr-uuid-42',
      patch: { title: 'new' },
    });
    expect(signer.oboMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: USER_ID,
        aud: 'mcp-knowledge2',
        on_behalf_of: 'axel@example.org',
        approval_id: 'appr-uuid-42',
      }),
    );
  });

  it('omits approval_id from OBO when read-only call', async () => {
    const signer = makeSigner();
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, defaultObjectView()),
    );
    const adapter = makeAdapter({
      fetchImpl: fetchMock,
      signer,
      serviceToken: 'svc-token',
    });
    await adapter.getObject({ id: 'o1', userId: USER_ID, userEmail: 'a@b.de' });
    const oboArgs = signer.oboMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(oboArgs['approval_id']).toBeUndefined();
  });

  it('LEGACY-Pfad: ohne serviceToken nutzt weiterhin signer.sign + Bearer-JWT', async () => {
    const signer = makeSigner('legacy-bearer', 'unused-obo');
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, defaultObjectView()),
    );
    const adapter = makeAdapter({
      fetchImpl: fetchMock,
      signer,
      // KEIN serviceToken → Legacy-Pfad.
    });
    await adapter.getObject({ id: 'o1', userId: USER_ID });
    expect(signer.signMock).toHaveBeenCalledTimes(1);
    expect(signer.oboMock).not.toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer legacy-bearer');
    expect(headers['x-on-behalf-of']).toBeUndefined();
  });
});

describe('HttpKnowledgeAdapter — syncUser (AS-3 §2.2 / A11)', () => {
  it('POSTs to /v1/internal/users/sync with service-token (NOT JWT)', async () => {
    const signer = makeSigner();
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, { status: 'created', kc_user_id: 'kc-user-1' }),
    );
    const adapter = makeAdapter({
      fetchImpl: fetchMock,
      signer,
      serviceToken: 'svc-token-abc',
    });
    const res = await adapter.syncUser({
      userId: USER_ID,
      email: 'axel@example.org',
      displayName: 'Axel R.',
      status: 'active',
      externalId: 'google-sub-123',
    });

    // syncUser ist ein Admin-Call → kein signer-Call.
    expect(signer.signMock).not.toHaveBeenCalled();
    expect(signer.oboMock).not.toHaveBeenCalled();

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://knowledge.example.org/v1/internal/users/sync');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer svc-token-abc');
    expect(headers['x-on-behalf-of']).toBeUndefined();

    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      user_id: USER_ID,
      email: 'axel@example.org',
      display_name: 'Axel R.',
      status: 'active',
      external_id: 'google-sub-123',
    });

    expect(res).toEqual({ status: 'created', kcUserId: 'kc-user-1' });
  });

  it('omits external_id from body when not provided', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, { status: 'updated', kc_user_id: 'kc-user-2' }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock, serviceToken: 'tok' });
    await adapter.syncUser({
      userId: USER_ID,
      email: 'b@c.de',
      displayName: 'Test',
      status: 'suspended',
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['external_id']).toBeUndefined();
    expect(body['status']).toBe('suspended');
  });

  it('throws ServiceError if serviceToken not configured', async () => {
    const fetchMock = vi.fn<FetchLike>();
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await expect(
      adapter.syncUser({
        userId: USER_ID,
        email: 'x@y.de',
        displayName: 'X',
        status: 'active',
      }),
    ).rejects.toMatchObject({
      name: 'ServiceError',
      message: expect.stringContaining('serviceToken not configured') as unknown as string,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('HttpKnowledgeAdapter — eraseUser (D-10)', () => {
  it('uses service token (NOT JWT) and posts snake_case body', async () => {
    const signer = makeSigner();
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, {
        status: 'ok',
        deleted: {
          objects: 12,
          shares: 3,
          idempotency: 0,
          uploads: 0,
          audit_pseudonymised: 7,
          blobs_deleted: 12,
          blobs_pending: 0,
        },
      }),
    );
    const adapter = makeAdapter({
      fetchImpl: fetchMock,
      signer,
      serviceToken: 'svc-token-abc',
    });
    const result = await adapter.eraseUser({ userId: USER_ID, confirmationToken: 'tok-confirm-xyz-1234567890' });

    // Service-Token-Path: KEIN JWT-Sign-Call.
    expect(signer.mock).not.toHaveBeenCalled();

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://knowledge.example.org/v1/internal/erase-user');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer svc-token-abc');

    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      user_id: USER_ID,
      confirmation_token: 'tok-confirm-xyz-1234567890',
    });

    // Rich response mapping
    expect(result).toEqual({
      status: 'ok',
      deleted: {
        objects: 12,
        shares: 3,
        idempotency: 0,
        uploads: 0,
        auditPseudonymised: 7,
        blobsDeleted: 12,
        blobsPending: 0,
      },
      deletedRows: 12, // backwards-compat alias
    });
  });

  it('throws ServiceError if serviceToken not configured', async () => {
    const fetchMock = vi.fn<FetchLike>();
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await expect(
      adapter.eraseUser({ userId: USER_ID, confirmationToken: 'tok' }),
    ).rejects.toMatchObject({
      name: 'ServiceError',
      message: expect.stringContaining('serviceToken not configured') as unknown as string,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
