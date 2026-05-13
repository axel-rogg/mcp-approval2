/**
 * VertexAiAdapter — Unit-Tests mit mocked fetch.
 *
 * Scope:
 *   - embed(): URL-Format, headers, body-Mapping, response-parsing
 *   - chat(): URL-Format, systemInstruction-Split, role-mapping (assistant→model),
 *     finishReason-mapping
 *   - VertexAuth: JWT-sign + token-exchange + caching + concurrent-call-coalesce
 *   - Error-Pfade: non-2xx → VertexAiError mit status
 *
 * Keine echten Live-Vertex-Calls. Keine echten Service-Accounts. Generierter
 * RSA-PEM mittels jose's `generateKeyPair`+`exportPKCS8`.
 */
import { describe, expect, it } from 'vitest';
import { exportPKCS8, generateKeyPair } from 'jose';
import { VertexAiAdapter } from './vertex.js';
import { VertexAuth } from './vertex-auth.js';
import { VertexAiError } from './vertex-types.js';

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

function makeFetchMock(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = ((url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = typeof url === 'string' ? url : url.toString();
    const finalInit = init ?? {};
    calls.push({ url: u, init: finalInit });
    return Promise.resolve(responder(u, finalInit));
  }) as typeof fetch;
  return { fn, calls };
}

/** Generates a real RSA-private-key PKCS8-PEM fuer VertexAuth-Tests. */
async function makeServiceAccountJson(opts: { tokenUri: string }): Promise<string> {
  const kp = await generateKeyPair('RS256', { extractable: true });
  const pkcs8 = await exportPKCS8(kp.privateKey);
  return JSON.stringify({
    client_email: 'svc@test.iam.gserviceaccount.com',
    private_key: pkcs8,
    token_uri: opts.tokenUri,
  });
}

describe('VertexAiAdapter.embed', () => {
  it('builds correct URL + posts texts → returns Float32Array per text', async () => {
    const mockToken = 'ya29.fake';
    const responder = (url: string): Response => {
      if (url.includes(':predict')) {
        return new Response(
          JSON.stringify({
            predictions: [
              { embeddings: { values: [0.1, 0.2, 0.3] } },
              { embeddings: { values: [0.4, 0.5, 0.6] } },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('not-found', { status: 404 });
    };
    const { fn: fetchMock, calls } = makeFetchMock(responder);

    const adapter = new VertexAiAdapter({
      projectId: 'proj-test',
      region: 'europe-west4',
      auth: { mode: 'service-account-json', keyJson: '{}' }, // not used because authProvider given
      fetchImpl: fetchMock,
      authProvider: { getAccessToken: async () => mockToken },
    });

    const result = await adapter.embed({ texts: ['hello', 'world'] });

    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(result[0]!)).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
    ]);
    expect(Array.from(result[1]!)).toEqual([
      Math.fround(0.4),
      Math.fround(0.5),
      Math.fround(0.6),
    ]);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(
      'https://europe-west4-aiplatform.googleapis.com/v1/projects/proj-test/locations/europe-west4/publishers/google/models/text-embedding-005:predict',
    );
    const headers = call.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${mockToken}`);
    expect(headers['Content-Type']).toBe('application/json');
    const parsedBody = JSON.parse(call.init.body as string) as {
      instances: Array<{ content: string; taskType: string }>;
    };
    expect(parsedBody.instances).toEqual([
      { content: 'hello', taskType: 'RETRIEVAL_DOCUMENT' },
      { content: 'world', taskType: 'RETRIEVAL_DOCUMENT' },
    ]);
  });

  it('returns empty array for empty input without calling fetch', async () => {
    const { fn: fetchMock, calls } = makeFetchMock(
      () => new Response('should-not-be-called', { status: 500 }),
    );
    const adapter = new VertexAiAdapter({
      projectId: 'proj-test',
      auth: { mode: 'service-account-json', keyJson: '{}' },
      fetchImpl: fetchMock,
      authProvider: { getAccessToken: async () => 'x' },
    });
    const result = await adapter.embed({ texts: [] });
    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('throws VertexAiError on non-2xx', async () => {
    const { fn: fetchMock } = makeFetchMock(
      () => new Response('quota exceeded', { status: 429 }),
    );
    const adapter = new VertexAiAdapter({
      projectId: 'p',
      auth: { mode: 'service-account-json', keyJson: '{}' },
      fetchImpl: fetchMock,
      authProvider: { getAccessToken: async () => 'x' },
    });
    await expect(adapter.embed({ texts: ['a'] })).rejects.toBeInstanceOf(VertexAiError);
    await expect(adapter.embed({ texts: ['a'] })).rejects.toMatchObject({ status: 429 });
  });
});

describe('VertexAiAdapter.chat', () => {
  it('maps messages → contents (assistant→model), splits system, parses response', async () => {
    const responder = (): Response =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'Hi there!' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 42,
            candidatesTokenCount: 7,
            totalTokenCount: 49,
          },
        }),
        { status: 200 },
      );
    const { fn: fetchMock, calls } = makeFetchMock(responder);

    const adapter = new VertexAiAdapter({
      projectId: 'p',
      region: 'europe-west4',
      auth: { mode: 'service-account-json', keyJson: '{}' },
      fetchImpl: fetchMock,
      authProvider: { getAccessToken: async () => 'tok' },
    });

    const result = await adapter.chat({
      messages: [
        { role: 'system', content: 'You are a helpful bot.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi back.' },
        { role: 'user', content: 'How are you?' },
      ],
      temperature: 0.5,
      maxTokens: 256,
    });

    expect(result.content).toBe('Hi there!');
    expect(result.finishReason).toBe('stop');
    expect(result.usage.inputTokens).toBe(42);
    expect(result.usage.outputTokens).toBe(7);
    expect(result.model).toBe('gemini-2.0-flash-exp');

    const call = calls[0]!;
    expect(call.url).toContain('gemini-2.0-flash-exp:generateContent');
    const body = JSON.parse(call.init.body as string) as {
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
      systemInstruction?: { role: string; parts: Array<{ text: string }> };
      generationConfig: { maxOutputTokens: number; temperature: number };
    };
    expect(body.systemInstruction?.parts[0]?.text).toBe('You are a helpful bot.');
    expect(body.contents).toHaveLength(3);
    expect(body.contents[0]?.role).toBe('user');
    expect(body.contents[1]?.role).toBe('model');
    expect(body.contents[2]?.role).toBe('user');
    expect(body.generationConfig.maxOutputTokens).toBe(256);
    expect(body.generationConfig.temperature).toBe(0.5);
  });

  it('maps MAX_TOKENS → length, SAFETY → content_filter', async () => {
    let calls = 0;
    const responder = (): Response => {
      calls += 1;
      const finishReason = calls === 1 ? 'MAX_TOKENS' : 'SAFETY';
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'partial' }] },
              finishReason,
            },
          ],
          usageMetadata: {},
        }),
        { status: 200 },
      );
    };
    const { fn: fetchMock } = makeFetchMock(responder);
    const adapter = new VertexAiAdapter({
      projectId: 'p',
      auth: { mode: 'service-account-json', keyJson: '{}' },
      fetchImpl: fetchMock,
      authProvider: { getAccessToken: async () => 'tok' },
    });

    const r1 = await adapter.chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(r1.finishReason).toBe('length');
    const r2 = await adapter.chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(r2.finishReason).toBe('content_filter');
  });

  it('merges consecutive same-role messages (Vertex sequence-constraint)', async () => {
    const { fn: fetchMock, calls } = makeFetchMock(
      () =>
        new Response(
          JSON.stringify({
            candidates: [
              { content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' },
            ],
            usageMetadata: {},
          }),
          { status: 200 },
        ),
    );
    const adapter = new VertexAiAdapter({
      projectId: 'p',
      auth: { mode: 'service-account-json', keyJson: '{}' },
      fetchImpl: fetchMock,
      authProvider: { getAccessToken: async () => 'tok' },
    });
    await adapter.chat({
      messages: [
        { role: 'user', content: 'part 1' },
        { role: 'user', content: 'part 2' },
      ],
    });
    const body = JSON.parse(calls[0]!.init.body as string) as {
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    };
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0]?.parts[0]?.text).toBe('part 1\npart 2');
  });
});

describe('VertexAuth', () => {
  it('signs JWT, exchanges for access-token, caches', async () => {
    const tokenUri = 'https://oauth2.example.com/token';
    const keyJson = await makeServiceAccountJson({ tokenUri });

    let exchangeCount = 0;
    const responder = (url: string): Response => {
      if (url === tokenUri) {
        exchangeCount += 1;
        return new Response(
          JSON.stringify({
            access_token: `tok-${exchangeCount}`,
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200 },
        );
      }
      return new Response('?', { status: 404 });
    };
    const { fn: fetchMock, calls } = makeFetchMock(responder);

    let now = 1_000_000_000_000;
    const auth = new VertexAuth({
      serviceAccountJson: JSON.parse(keyJson),
      fetchImpl: fetchMock,
      now: () => now,
    });

    const t1 = await auth.getAccessToken();
    expect(t1).toBe('tok-1');
    expect(exchangeCount).toBe(1);

    // 2nd call within TTL → cache-hit
    const t2 = await auth.getAccessToken();
    expect(t2).toBe('tok-1');
    expect(exchangeCount).toBe(1);

    // Verify body was form-encoded jwt-bearer
    const exchangeCall = calls[0]!;
    expect(exchangeCall.url).toBe(tokenUri);
    expect((exchangeCall.init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    const params = new URLSearchParams(exchangeCall.init.body as string);
    expect(params.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    );
    expect(params.get('assertion')).toBeTruthy();

    // Advance clock past TTL → refetch
    now += 3600 * 1000;
    const t3 = await auth.getAccessToken();
    expect(t3).toBe('tok-2');
    expect(exchangeCount).toBe(2);
  });

  it('coalesces concurrent calls into one token exchange', async () => {
    const tokenUri = 'https://oauth2.example.com/token';
    const keyJson = await makeServiceAccountJson({ tokenUri });

    let exchangeCount = 0;
    let resolveExchange: ((value: Response) => void) | undefined;
    const responder = (): Promise<Response> => {
      exchangeCount += 1;
      return new Promise<Response>((resolve) => {
        resolveExchange = resolve;
      });
    };
    const { fn: fetchMock } = makeFetchMock(responder);

    const auth = new VertexAuth({
      serviceAccountJson: JSON.parse(keyJson),
      fetchImpl: fetchMock,
    });
    const p1 = auth.getAccessToken();
    const p2 = auth.getAccessToken();
    // Both should attach to the same pending fetch.
    // Wait until the fetch-mock got called — JWT-sign is async (webcrypto),
    // so we cannot rely on a single microtask.
    for (let i = 0; i < 50 && exchangeCount === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(exchangeCount).toBe(1);
    resolveExchange!(
      new Response(
        JSON.stringify({ access_token: 'tok-x', expires_in: 3600, token_type: 'Bearer' }),
        { status: 200 },
      ),
    );
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('tok-x');
    expect(r2).toBe('tok-x');
  });

  it('throws on non-2xx token-exchange', async () => {
    const tokenUri = 'https://oauth2.example.com/token';
    const keyJson = await makeServiceAccountJson({ tokenUri });
    const { fn: fetchMock } = makeFetchMock(
      () => new Response('invalid_grant', { status: 400 }),
    );
    const auth = new VertexAuth({
      serviceAccountJson: JSON.parse(keyJson),
      fetchImpl: fetchMock,
    });
    await expect(auth.getAccessToken()).rejects.toThrow(/token exchange failed/);
  });
});
