/**
 * Tests fuer kc_wrappers/* — Auto-Generator + Forwarder.
 *
 * Plan-Ref: PLAN-as3-autonomous.md §1.4 + A8.
 *
 * Scope (Unit-level, ohne echtes KC2):
 *   - `fetchKcManifest` parsed JSON-RPC tools/list-Response korrekt
 *   - `buildKcWrappers` generiert Tool-Objekte mit sensitivity + display_template
 *   - Approval-Pflicht-Routing: `write===true` Annotation → 'write' sensitivity
 *   - Override-up funktioniert, override-down wird ignoriert
 *   - Graceful: KC2-Unreach → empty array, kein throw
 *   - `forwardToKc` baut korrekten POST mit OBO-Header + Service-Token
 */
import { describe, it, expect, vi } from 'vitest';
import { fetchKcManifest, buildKcWrappers, forwardToKc } from './index.js';
import type { JwtSigner } from '@mcp-approval2/adapters';
import type { ToolContext } from '../../mcp/protocol/tool.js';

function makeSigner(oboToken = 'obo-jwt'): JwtSigner & { oboMock: ReturnType<typeof vi.fn> } {
  const oboMock = vi.fn().mockResolvedValue(oboToken);
  return {
    sign: vi.fn().mockResolvedValue('unused'),
    signOBO: oboMock,
    oboMock,
  };
}

function jsonRpcResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchKcManifest', () => {
  it('parses JSON-RPC tools/list response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            {
              name: 'objects.create',
              description: 'Create an object',
              inputSchema: { type: 'object' },
              annotations: { write: true, displayTemplate: 'Create object {{kind}}' },
            },
            {
              name: 'objects.list',
              description: 'List objects',
              inputSchema: { type: 'object' },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      }),
    );

    const manifest = await fetchKcManifest({
      knowledgeUrl: 'https://kc.example.test',
      serviceToken: 'tok',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(manifest.tools).toHaveLength(2);
    expect(manifest.tools[0]?.name).toBe('objects.create');

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://kc.example.test/mcp');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer tok');
    expect(headers['content-type']).toBe('application/json');
  });

  it('throws on HTTP error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    await expect(
      fetchKcManifest({
        knowledgeUrl: 'https://kc',
        serviceToken: 'tok',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('throws on malformed JSON-RPC', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRpcResponse({ foo: 'bar' }));
    await expect(
      fetchKcManifest({
        knowledgeUrl: 'https://kc',
        serviceToken: 'tok',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/malformed jsonrpc/);
  });

  it('skips malformed entries without bailing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            { name: 'good', description: 'd', inputSchema: { type: 'object' } },
            { foo: 'bad' }, // skipped
            null, // skipped
          ],
        },
      }),
    );
    const manifest = await fetchKcManifest({
      knowledgeUrl: 'https://kc',
      serviceToken: 'tok',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(manifest.tools.map((t) => t.name)).toEqual(['good']);
  });
});

describe('buildKcWrappers', () => {
  it('generates Tool with sensitivity from annotations.write===true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            {
              name: 'objects.create',
              description: 'Create',
              inputSchema: { type: 'object' },
              annotations: { write: true, displayTemplate: 'Create {{kind}}' },
            },
          ],
        },
      }),
    );
    const { tools } = await buildKcWrappers({
      knowledgeUrl: 'https://kc',
      serviceToken: 'tok',
      signer: makeSigner(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('objects.create');
    expect(tools[0]?.sensitivity).toBe('write');
    expect(tools[0]?.displayTemplate).toBe('Create {{kind}}');
  });

  // SEC-006: fail-closed Default — KC2 vergisst sensitivity-Annotation,
  // approval2 darf NICHT auf read defaulten.
  it('SEC-006: tool ohne sensitivity-annotation → write (fail-closed default)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            {
              name: 'mystery.tool',
              description: 'Tool without any sensitivity hint',
              inputSchema: { type: 'object' },
              // KEINE annotations
            },
          ],
        },
      }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tools } = await buildKcWrappers({
      knowledgeUrl: 'https://kc',
      serviceToken: 'tok',
      signer: makeSigner(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(tools[0]?.sensitivity).toBe('write');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"mystery.tool"'),
    );
    warnSpy.mockRestore();
  });

  it('SEC-006: destructiveHint=true → danger (kein write-downgrade)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            {
              name: 'objects.purge',
              description: 'Hard-delete',
              inputSchema: { type: 'object' },
              annotations: { destructiveHint: true },
            },
          ],
        },
      }),
    );
    const { tools } = await buildKcWrappers({
      knowledgeUrl: 'https://kc',
      serviceToken: 'tok',
      signer: makeSigner(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(tools[0]?.sensitivity).toBe('danger');
  });

  it('readOnlyHint → sensitivity read', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            {
              name: 'objects.list',
              description: 'List',
              inputSchema: { type: 'object' },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      }),
    );
    const { tools } = await buildKcWrappers({
      knowledgeUrl: 'https://kc',
      serviceToken: 'tok',
      signer: makeSigner(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(tools[0]?.sensitivity).toBe('read');
  });

  it('sensitivityOverrides up-grades but does not downgrade', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            {
              name: 'objects.create',
              description: 'Create',
              inputSchema: { type: 'object' },
              annotations: { write: true },
            },
            {
              name: 'objects.list',
              description: 'List',
              inputSchema: { type: 'object' },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      }),
    );
    const { tools } = await buildKcWrappers({
      knowledgeUrl: 'https://kc',
      serviceToken: 'tok',
      signer: makeSigner(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      sensitivityOverrides: {
        'objects.create': 'danger', // up — wirkt
        'objects.list': 'danger', // up — wirkt
        // Down-Tests koennen wir nicht direkt, weil wir bei reads keinen
        // override-down formulieren wuerden — Logik im resolveSensitivity
        // pruefen wir oben durch readOnlyHint-Default.
      },
    });
    expect(tools.find((t) => t.name === 'objects.create')?.sensitivity).toBe('danger');
    expect(tools.find((t) => t.name === 'objects.list')?.sensitivity).toBe('danger');
  });

  it('refuses sensitivity downgrade (write → read override ignored)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            {
              name: 'objects.create',
              description: 'Create',
              inputSchema: { type: 'object' },
              annotations: { write: true },
            },
          ],
        },
      }),
    );
    const { tools } = await buildKcWrappers({
      knowledgeUrl: 'https://kc',
      serviceToken: 'tok',
      signer: makeSigner(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      sensitivityOverrides: {
        'objects.create': 'read', // down — sollte ignoriert werden
      },
    });
    expect(tools[0]?.sensitivity).toBe('write');
  });

  it('graceful on KC2 fetch failure (empty tools, no throw)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const { tools, manifest } = await buildKcWrappers({
      knowledgeUrl: 'https://kc',
      serviceToken: 'tok',
      signer: makeSigner(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(tools).toHaveLength(0);
    expect(manifest.tools).toHaveLength(0);
  });
});

describe('forwardToKc — execute path', () => {
  it('builds POST with OBO-Header + Service-Token + forwards arguments', async () => {
    const signer = makeSigner('obo-token-xyz');
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({
        jsonrpc: '2.0',
        id: 'req-1',
        result: { content: [{ type: 'text', text: 'ok' }] },
      }),
    );
    const result = await forwardToKc({
      knowledgeUrl: 'https://kc.example',
      serviceToken: 'svc-token',
      signer,
      fetchImpl: fetchMock as unknown as typeof fetch,
      toolName: 'objects.create',
      arguments: { subtype: 'doc', title: 'hi' },
      userId: 'user-1',
      userEmail: 'axel@x.de',
      approvalId: 'appr-42',
      requestId: 'req-1',
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.text).toBe('ok');

    expect(signer.oboMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: 'user-1',
        aud: 'mcp-knowledge2',
        on_behalf_of: 'axel@x.de',
        approval_id: 'appr-42',
        request_id: 'req-1',
        ttlSec: 120,
      }),
    );

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://kc.example/mcp');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer svc-token');
    expect(headers['x-on-behalf-of']).toBe('obo-token-xyz');
    expect(headers['x-request-id']).toBe('req-1');

    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body['method']).toBe('tools/call');
    const params = body['params'] as Record<string, unknown>;
    expect(params['name']).toBe('objects.create');
    expect(params['arguments']).toEqual({ subtype: 'doc', title: 'hi' });
  });

  it('omits approval_id when not provided (reads)', async () => {
    const signer = makeSigner();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({ jsonrpc: '2.0', id: 'r', result: { content: [] } }),
    );
    await forwardToKc({
      knowledgeUrl: 'https://kc',
      serviceToken: 'tok',
      signer,
      fetchImpl: fetchMock as unknown as typeof fetch,
      toolName: 'objects.list',
      arguments: {},
      userId: 'u',
      userEmail: 'x@y.de',
      requestId: 'r',
    });
    const oboArgs = signer.oboMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(oboArgs['approval_id']).toBeUndefined();
  });

  it('throws on JSON-RPC error response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({
        jsonrpc: '2.0',
        id: 'r',
        error: { code: -32011, message: 'tool blew up' },
      }),
    );
    await expect(
      forwardToKc({
        knowledgeUrl: 'https://kc',
        serviceToken: 'tok',
        signer: makeSigner(),
        fetchImpl: fetchMock as unknown as typeof fetch,
        toolName: 'objects.create',
        arguments: {},
        userId: 'u',
        userEmail: 'x@y.de',
        requestId: 'r',
      }),
    ).rejects.toThrow(/tool blew up/);
  });
});

describe('buildKcWrappers — execute integration', () => {
  it('built tool forwards via OBO when ctx.approvalId is set', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRpcResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            tools: [
              {
                name: 'objects.create',
                description: 'Create',
                inputSchema: { type: 'object' },
                annotations: { write: true },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonRpcResponse({
          jsonrpc: '2.0',
          id: 'r',
          result: { content: [{ type: 'text', text: 'created' }] },
        }),
      );
    const signer = makeSigner('obo-token-int');
    const { tools } = await buildKcWrappers({
      knowledgeUrl: 'https://kc',
      serviceToken: 'svc-token',
      signer,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const tool = tools[0]!;
    const ctx: ToolContext = {
      userId: 'u-1',
      email: 'a@b.de',
      role: 'member',
      requestId: 'r',
      audit: { emit: vi.fn() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      signal: new AbortController().signal,
      approvalId: 'appr-99',
    };
    const result = await tool.execute(ctx, { subtype: 'doc' });
    expect((result as Array<{ text?: string }>)[0]?.text).toBe('created');
    const oboArgs = signer.oboMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(oboArgs['approval_id']).toBe('appr-99');
    expect(oboArgs['on_behalf_of']).toBe('a@b.de');
  });
});
