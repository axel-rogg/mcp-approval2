/**
 * Cross-Service Contract-Test (T3-1 approval2-side): kc_wrappers forwarder ↔ KC2 MCP.
 *
 * Plan-Ref: PLAN-as3-autonomous.md §1.4 (approval2 forwards tools/call to KC2 with
 *           OBO + service-token), §2.1 (OBO-JWT shape).
 *
 * Validates the request approval2 BUILDS for KC2's `POST /mcp` is exactly
 * what the KC2-side OBO + MCP-transport stack expects.
 *
 * Wire-shape pinned here (consumed by KC2's src/mcp/server.ts +
 * src/auth/on_behalf_of.ts):
 *
 *   POST /mcp HTTP/1.1
 *   Authorization: Bearer <SERVICE_TOKEN>           ← from SERVICE_TOKEN env
 *   X-On-Behalf-Of:  <OBO-JWT>                      ← signed via JwtSigner.signOBO
 *   X-Request-Id:    <UUID>
 *   Accept:          application/json, text/event-stream
 *   Content-Type:    application/json
 *   {"jsonrpc":"2.0","id":<UUID>,"method":"tools/call",
 *    "params":{"name":"<tool>","arguments":{…}}}
 *
 * Counter-tests on the KC2 side (tests/contract/obo-jwt.test.ts) verify the same
 * OBO-JWT structure is accepted there. Together they form a closed contract.
 */
import { describe, it, expect, vi } from 'vitest';
import { forwardToKc } from '../../src/tools/kc_wrappers/forward.js';
import type { JwtSigner } from '@mcp-approval2/adapters';

function makeRecordingSigner(returnsObo: string): JwtSigner & {
  oboCalls: ReturnType<typeof vi.fn>;
} {
  const oboCalls = vi.fn().mockResolvedValue(returnsObo);
  return {
    sign: vi.fn().mockResolvedValue('unused-legacy-token'),
    signOBO: oboCalls,
    oboCalls,
  };
}

function jsonRpcResponse(result: unknown, opts: { status?: number } = {}): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: 'r', result }),
    { status: opts.status ?? 200, headers: { 'content-type': 'application/json' } },
  );
}

// ─── OBO-JWT signing args contract ────────────────────────────────────────

describe('approval2 forwardToKc — OBO-JWT signing args (KC2-side contract)', () => {
  it('passes the canonical OBO-JWT claim set to the signer', async () => {
    const signer = makeRecordingSigner('signed-obo-token');
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({ content: [{ type: 'text', text: 'ok' }] }),
    );
    await forwardToKc({
      knowledgeUrl: 'https://knowledge.firma.de',
      serviceToken: 'svc-token-x',
      signer,
      toolName: 'objects.create',
      arguments: { subtype: 'doc' },
      userId: '11111111-1111-1111-1111-111111111111',
      userEmail: 'axel@example.org',
      requestId: '33333333-3333-3333-3333-333333333333',
      approvalId: '22222222-2222-2222-2222-222222222222',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(signer.oboCalls).toHaveBeenCalledTimes(1);
    const [args] = signer.oboCalls.mock.calls[0] as [Record<string, unknown>];
    // Pin every claim approval2 sends — these must match KC2's verifier expectations.
    expect(args).toMatchObject({
      sub: '11111111-1111-1111-1111-111111111111',
      aud: 'mcp-knowledge2',
      on_behalf_of: 'axel@example.org',
      ttlSec: 120,
      request_id: '33333333-3333-3333-3333-333333333333',
      approval_id: '22222222-2222-2222-2222-222222222222',
    });
  });

  it('omits approval_id when the call is a read-op (KC2-side K-D4 read path)', async () => {
    const signer = makeRecordingSigner('signed');
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({ content: [{ type: 'text', text: 'ok' }] }),
    );
    await forwardToKc({
      knowledgeUrl: 'https://kc',
      serviceToken: 'svc',
      signer,
      toolName: 'objects.list',
      arguments: { subtype: 'doc' },
      userId: 'u1',
      userEmail: 'a@b.de',
      requestId: 'r1',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const [args] = signer.oboCalls.mock.calls[0] as [Record<string, unknown>];
    expect(args).not.toHaveProperty('approval_id');
    expect(args.aud).toBe('mcp-knowledge2');
    expect(args.ttlSec).toBe(120);
  });
});

// ─── HTTP-Header contract ─────────────────────────────────────────────────

describe('approval2 forwardToKc — HTTP-Header contract (KC2-side require_jwt_or_obo)', () => {
  it('emits the two-factor headers exactly: Authorization(Bearer SERVICE_TOKEN) + X-On-Behalf-Of', async () => {
    const signer = makeRecordingSigner('obo-jwt-string');
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({ content: [{ type: 'text', text: 'ok' }] }),
    );
    await forwardToKc({
      knowledgeUrl: 'https://kc.firma.de',
      serviceToken: 'service-bearer-token-12345',
      signer,
      toolName: 'objects.get',
      arguments: { id: 'abc' },
      userId: 'u',
      userEmail: 'a@b.de',
      requestId: 'corr-uuid',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const h = init.headers as Record<string, string>;
    expect(h['authorization']).toBe('Bearer service-bearer-token-12345');
    expect(h['x-on-behalf-of']).toBe('obo-jwt-string');
    expect(h['x-request-id']).toBe('corr-uuid');
    expect(h['content-type']).toBe('application/json');
    // MCP Streamable-HTTP demands BOTH json + text/event-stream in Accept.
    expect(h['accept']).toContain('application/json');
    expect(h['accept']).toContain('text/event-stream');
  });

  it('targets POST /mcp at the canonical path (no /v1 prefix)', async () => {
    const signer = makeRecordingSigner('o');
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({ content: [] }),
    );
    await forwardToKc({
      knowledgeUrl: 'https://kc/',  // trailing-slash robustness
      serviceToken: 'svc',
      signer,
      toolName: 'search',
      arguments: { query: 'x' },
      userId: 'u',
      userEmail: 'a@b.de',
      requestId: 'r',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://kc/mcp');
    expect(init.method).toBe('POST');
  });
});

// ─── JSON-RPC body contract ───────────────────────────────────────────────

describe('approval2 forwardToKc — JSON-RPC body contract', () => {
  it('sends a JSON-RPC 2.0 tools/call envelope', async () => {
    const signer = makeRecordingSigner('o');
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({ content: [{ type: 'text', text: 'ok' }] }),
    );
    await forwardToKc({
      knowledgeUrl: 'https://kc',
      serviceToken: 'svc',
      signer,
      toolName: 'objects.create',
      arguments: { subtype: 'doc', title: 'hi' },
      userId: 'u',
      userEmail: 'a@b.de',
      requestId: 'req-1',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe('req-1'); // requestId echoed as JSON-RPC id
    expect(body.method).toBe('tools/call');
    expect(body.params).toEqual({
      name: 'objects.create',
      arguments: { subtype: 'doc', title: 'hi' },
    });
  });

  it('sends params.arguments={} when no args provided (KC2 expects an object)', async () => {
    const signer = makeRecordingSigner('o');
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({ content: [] }),
    );
    await forwardToKc({
      knowledgeUrl: 'https://kc',
      serviceToken: 'svc',
      signer,
      toolName: 'health.ping',
      arguments: undefined,
      userId: 'u',
      userEmail: 'a@b.de',
      requestId: 'r',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.params.arguments).toEqual({});
  });
});

// ─── Response-Shape contract (what KC2 sends back) ────────────────────────

describe('approval2 forwardToKc — KC2 response handling', () => {
  it('unwraps JSON-RPC result and propagates content[]', async () => {
    const signer = makeRecordingSigner('o');
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({ content: [{ type: 'text', text: 'created' }] }),
    );
    const res = await forwardToKc({
      knowledgeUrl: 'https://kc',
      serviceToken: 'svc',
      signer,
      toolName: 'objects.create',
      arguments: {},
      userId: 'u',
      userEmail: 'a@b.de',
      requestId: 'r',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(res.content).toEqual([{ type: 'text', text: 'created' }]);
  });

  it('propagates structuredContent when KC2 emits it', async () => {
    const signer = makeRecordingSigner('o');
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { id: 'obj-1', subtype: 'doc' },
      }),
    );
    const res = await forwardToKc({
      knowledgeUrl: 'https://kc',
      serviceToken: 'svc',
      signer,
      toolName: 'objects.get',
      arguments: { id: 'obj-1' },
      userId: 'u',
      userEmail: 'a@b.de',
      requestId: 'r',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(res.structuredContent).toEqual({ id: 'obj-1', subtype: 'doc' });
  });

  it('throws on JSON-RPC error envelope (KC2 reports tool failure)', async () => {
    const signer = makeRecordingSigner('o');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'r',
          error: { code: -32001, message: 'tool not registered: objects.bogus' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(
      forwardToKc({
        knowledgeUrl: 'https://kc',
        serviceToken: 'svc',
        signer,
        toolName: 'objects.bogus',
        arguments: {},
        userId: 'u',
        userEmail: 'a@b.de',
        requestId: 'r',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/code=-32001/);
  });

  it('throws when KC2 returns non-2xx HTTP status', async () => {
    const signer = makeRecordingSigner('o');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"err":"unauthorized"}', { status: 401 }),
    );
    await expect(
      forwardToKc({
        knowledgeUrl: 'https://kc',
        serviceToken: 'svc',
        signer,
        toolName: 'objects.get',
        arguments: { id: '1' },
        userId: 'u',
        userEmail: 'a@b.de',
        requestId: 'r',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 401/);
  });
});
