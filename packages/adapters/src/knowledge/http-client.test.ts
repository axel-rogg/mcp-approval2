/**
 * HttpKnowledgeAdapter tests — mocked fetch + JwtSigner.
 *
 * Wir prueffen:
 *   1. authedFetch baut korrekten URL + Header (Authorization Bearer + X-Request-ID)
 *   2. JwtSigner wird mit sub=userId + ttl aufgerufen, scope durchgereicht
 *   3. JSON-Body wird gesendet wenn vorhanden, sonst kein Content-Type
 *   4. Error-Mapping: 400→Validation, 401→Auth, 403→Permission, 404→NotFound, 409→Conflict, 429→RateLimit, 5xx→Service
 *   5. 204 No Content → void
 *   6. Network-Error → ServiceError
 *   7. Methoden-Surface: createObject/getObject/listObjects/updateObject/deleteObject/createShare/listShares/revokeShare/search/eraseUser
 *   8. Search akzeptiert beide Response-Shapes (array oder {items})
 *   9. List-Query-Params werden serialisiert
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

function makeSigner(token = 'jwt-token-xyz'): JwtSigner & { mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn().mockResolvedValue(token);
  return { sign: mock, mock };
}

function makeJsonResponse(status: number, body: unknown, init?: { requestId?: string }): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init?.requestId) headers.set('x-request-id', init.requestId);
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers,
  });
}

function makeAdapter(opts: {
  fetchImpl: FetchLike;
  signer?: JwtSigner;
  baseUrl?: string;
  jwtTtlSec?: number;
}): HttpKnowledgeAdapter {
  return new HttpKnowledgeAdapter({
    baseUrl: opts.baseUrl ?? 'https://knowledge.example.org',
    jwtSigner: opts.signer ?? makeSigner(),
    fetchImpl: opts.fetchImpl,
    ...(opts.jwtTtlSec !== undefined ? { jwtTtlSec: opts.jwtTtlSec } : {}),
    requestIdFactory: () => 'req-test-1',
  });
}

describe('HttpKnowledgeAdapter — authedFetch + JWT', () => {
  it('signs JWT with userId as sub and ttl, forwards as Bearer', async () => {
    const signer = makeSigner('signed-jwt-abc');
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, { id: 'o1', ownerId: USER_ID, kind: 'doc' } as unknown),
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
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(makeJsonResponse(200, { items: [], cursor: null, hasMore: false }));
    const adapter = makeAdapter({ fetchImpl: fetchMock, signer, jwtTtlSec: 30 });
    await adapter.listObjects({ userId: USER_ID });
    expect(signer.mock).toHaveBeenCalledWith({ sub: USER_ID, ttlSec: 30, scope: 'objects:read' });
  });

  it('sends Content-Type + JSON body on POST', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, { id: 'o1', ownerId: USER_ID, kind: 'doc' }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.createObject({ userId: USER_ID, kind: 'doc', title: 'hello' });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = init?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ kind: 'doc', title: 'hello' }));
  });

  it('omits Content-Type for GET (no body)', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(makeJsonResponse(200, { items: [], cursor: null, hasMore: false }));
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.listObjects({ userId: USER_ID });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = init?.headers as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
  });

  it('strips trailing slash from baseUrl', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, { id: 'o1', ownerId: USER_ID, kind: 'doc' }),
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

describe('HttpKnowledgeAdapter — error mapping', () => {
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
  ])('maps HTTP %i to correct error class', async (status, Cls) => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(status, { error: { code: 'x', message: `boom ${status}` } }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await expect(adapter.getObject({ id: 'o1', userId: USER_ID })).rejects.toBeInstanceOf(Cls);
  });

  it('preserves message + details from error body', async () => {
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

  it('extracts x-request-id from response when present', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(404, { error: { code: 'not_found', message: 'missing' } }, { requestId: 'srv-req-42' }),
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

describe('HttpKnowledgeAdapter — methods', () => {
  it('createObject sends correct payload', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(201, { id: 'o1', ownerId: USER_ID, kind: 'doc' }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.createObject({
      userId: USER_ID,
      kind: 'doc',
      title: 'T',
      description: 'D',
      keywords: ['a', 'b'],
      body: 'body-text',
      visibility: 'private',
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      kind: 'doc',
      title: 'T',
      description: 'D',
      keywords: ['a', 'b'],
      body: 'body-text',
      visibility: 'private',
    });
  });

  it('listObjects serializes kind/limit/cursor as query params', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, { items: [], cursor: null, hasMore: false }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.listObjects({ userId: USER_ID, kind: 'skill', limit: 50, cursor: 'next-page' });
    const [url] = fetchMock.mock.calls[0] ?? [];
    const u = new URL(String(url));
    expect(u.pathname).toBe('/v1/objects');
    expect(u.searchParams.get('kind')).toBe('skill');
    expect(u.searchParams.get('limit')).toBe('50');
    expect(u.searchParams.get('cursor')).toBe('next-page');
  });

  it('updateObject uses PATCH', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, { id: 'o1', ownerId: USER_ID, kind: 'doc' }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.updateObject({ id: 'o1', userId: USER_ID, patch: { title: 'new' } });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://knowledge.example.org/v1/objects/o1');
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(JSON.stringify({ title: 'new' }));
  });

  it('deleteObject uses DELETE + handles 204', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(new Response(null, { status: 204 }));
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.deleteObject({ id: 'o1', userId: USER_ID });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.method).toBe('DELETE');
  });

  it('createShare hits /objects/{id}/shares with body', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(201, {
        id: 's1',
        resourceId: 'o1',
        resourceKind: 'doc',
        grantedBy: USER_ID,
        grantedTo: 'user-2',
        scope: 'read',
        createdAt: 1,
        revokedAt: null,
      }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.createShare({
      resourceId: 'o1',
      resourceKind: 'doc',
      userId: USER_ID,
      grantedTo: 'user-2',
      scope: 'read',
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://knowledge.example.org/v1/objects/o1/shares');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({ resourceKind: 'doc', grantedTo: 'user-2', scope: 'read' });
  });

  it('revokeShare hits /v1/shares/{id} with DELETE', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(new Response(null, { status: 204 }));
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    await adapter.revokeShare({ shareId: 's1', userId: USER_ID });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://knowledge.example.org/v1/shares/s1');
    expect(init?.method).toBe('DELETE');
  });

  it('search posts to /v1/search and accepts {items} shape', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, {
        items: [
          { id: 'o1', kind: 'doc', subtype: null, title: 'h', snippet: 's', score: 0.9, ownerId: USER_ID, sharedToMe: false },
        ],
      }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    const hits = await adapter.search({ userId: USER_ID, query: 'foo', kinds: ['doc'], limit: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe('o1');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://knowledge.example.org/v1/search');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({ query: 'foo', kinds: ['doc'], limit: 5 });
  });

  it('search also accepts bare-array response shape', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, [
        { id: 'o1', kind: 'doc', subtype: null, title: null, snippet: null, score: 0.5, ownerId: USER_ID, sharedToMe: false },
      ]),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    const hits = await adapter.search({ userId: USER_ID, query: 'foo' });
    expect(hits).toHaveLength(1);
  });

  it('eraseUser posts to /v1/internal/erase-user with token', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      makeJsonResponse(200, { deletedRows: 42 }),
    );
    const adapter = makeAdapter({ fetchImpl: fetchMock });
    const result = await adapter.eraseUser({ userId: USER_ID, confirmationToken: 'tok-xyz' });
    expect(result).toEqual({ deletedRows: 42 });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://knowledge.example.org/v1/internal/erase-user');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({ confirmationToken: 'tok-xyz' });
  });
});
