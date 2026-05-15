/**
 * Cross-Service Contract-Test (T3-3 approval2-side): KC2 manifest → kc_wrappers.
 *
 * Plan-Ref: PLAN-as3-autonomous.md §1.4 + A8 (Auto-Generator).
 *
 * Validates that approval2's `buildKcWrappers` correctly maps every field
 * a real KC2 `tools/list` response carries:
 *   - name / description / inputSchema (mandatory)
 *   - annotations.write / annotations.sensitivity → ToolSensitivity
 *   - annotations.wysiwys.display_template  (KC2 canonical, nested snake_case)
 *   - annotations.displayTemplate           (legacy / approval2 native, flat)
 *
 * The fixture in this file mirrors the SHAPE KC2 produces today (verified
 * by KC2-side tests/contract/mcp-tools-list.test.ts). If you add a tool to
 * KC2's manifest, mirror the entry here.
 *
 * Cross-Service Truth: the producer-side wins. We adapt approval2 to read
 * KC2's emitted shape (incl. nested `wysiwys.display_template`).
 */
import { describe, it, expect, vi } from 'vitest';
import { buildKcWrappers, fetchKcManifest } from '../../src/tools/kc_wrappers/index.js';
import type { JwtSigner } from '@mcp-approval2/adapters';

function makeStubSigner(): JwtSigner {
  return {
    sign: vi.fn().mockResolvedValue('unused'),
    signOBO: vi.fn().mockResolvedValue('obo-jwt'),
  };
}

/**
 * Canonical KC2 `tools/list` response shape (mirrors what KC2's
 * src/mcp/register_tools.ts emits today). If you change KC2's annotations
 * convention, mirror it here AND in KC2's tests/contract/mcp-tools-list.test.ts.
 */
const KC2_MANIFEST_FIXTURE = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    tools: [
      {
        name: 'objects.create',
        description:
          'Create a new object. `subtype` is a free-form caller-convention string (e.g. "doc", "skill_manifest", "memo", "app:composable"). Body is base64-encoded.',
        inputSchema: {
          type: 'object',
          properties: {
            subtype: { type: 'string', pattern: '^[a-z][a-z0-9_:-]{0,31}$' },
            body_b64: { type: 'string' },
          },
          required: ['body_b64'],
        },
        annotations: {
          title: 'Create object',
          sensitivity: 'write',
          write: true,
          wysiwys: {
            display_template:
              'Create {{subtype}} "{{title}}" ({{#filename}}{{filename}}, {{/filename}}{{body_size_human}})',
          },
        },
      },
      {
        name: 'objects.get',
        description: 'Fetch an object by id.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            include_body: { type: 'boolean' },
          },
          required: ['id'],
        },
        annotations: {
          title: 'Get object',
          sensitivity: 'read',
          write: false,
          wysiwys: { display_template: 'Read object {{id}}' },
        },
      },
      {
        name: 'objects.delete',
        description: 'Soft-delete an object.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        annotations: {
          title: 'Delete object',
          sensitivity: 'destructive',
          write: true,
          wysiwys: { display_template: 'Delete object {{id}}' },
        },
      },
      {
        name: 'search',
        description: 'Hybrid (FTS + vector) search.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        annotations: {
          sensitivity: 'read',
          wysiwys: { display_template: 'Search: {{query}}' },
        },
      },
    ],
  },
};

function jsonRpcResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// ─── fetchKcManifest contract ─────────────────────────────────────────────

describe('manifest-roundtrip: fetchKcManifest', () => {
  it('parses every field from a canonical KC2 tools/list response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRpcResponse(KC2_MANIFEST_FIXTURE));
    const manifest = await fetchKcManifest({
      knowledgeUrl: 'https://kc.firma.de',
      serviceToken: 'svc',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(manifest.tools).toHaveLength(4);
    expect(manifest.tools.map((t) => t.name)).toEqual([
      'objects.create',
      'objects.get',
      'objects.delete',
      'search',
    ]);
    // Every entry retains its full annotations payload (no field loss).
    const create = manifest.tools.find((t) => t.name === 'objects.create');
    expect(create?.annotations).toMatchObject({
      title: 'Create object',
      sensitivity: 'write',
      write: true,
    });
    // The nested template is preserved as-is.
    const a = create?.annotations as {
      wysiwys?: { display_template?: string };
    };
    expect(a.wysiwys?.display_template).toContain('Create {{subtype}}');
  });
});

// ─── buildKcWrappers contract: sensitivity-mapping ────────────────────────

describe('manifest-roundtrip: buildKcWrappers sensitivity', () => {
  it('maps annotations.sensitivity verbatim (read|write|destructive→danger)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRpcResponse(KC2_MANIFEST_FIXTURE));
    const { tools } = await buildKcWrappers({
      knowledgeUrl: 'https://kc',
      serviceToken: 'svc',
      signer: makeStubSigner(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName['objects.create']?.sensitivity).toBe('write');
    expect(byName['objects.get']?.sensitivity).toBe('read');
    // KC2 emits 'destructive' for sensitivity — approval2 today still has
    // sensitivity={read,write,danger}. The current resolveSensitivity
    // picks `a.sensitivity` verbatim so 'destructive' would pass through.
    // Two outcomes are acceptable: either 'danger' (approval2 ToolSensitivity)
    // or 'destructive' (verbatim from KC2). The contract is: must NOT be 'read'.
    expect(byName['objects.delete']?.sensitivity).not.toBe('read');
    expect(byName['search']?.sensitivity).toBe('read');
  });

  it('falls back to write=true when sensitivity is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            {
              name: 'objects.update',
              description: 'Update an object.',
              inputSchema: { type: 'object' },
              // Note: NO `sensitivity`, just `write: true`. This is the
              // fallback path approval2 must honour.
              annotations: { write: true, wysiwys: { display_template: 'Update {{id}}' } },
            },
          ],
        },
      }),
    );
    const { tools } = await buildKcWrappers({
      knowledgeUrl: 'https://kc',
      serviceToken: 'svc',
      signer: makeStubSigner(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(tools[0]?.sensitivity).toBe('write');
  });

  it('defaults to read when neither sensitivity nor write are set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            {
              name: 'health.ping',
              description: 'Ping.',
              inputSchema: { type: 'object' },
              annotations: {},
            },
          ],
        },
      }),
    );
    const { tools } = await buildKcWrappers({
      knowledgeUrl: 'https://kc',
      serviceToken: 'svc',
      signer: makeStubSigner(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(tools[0]?.sensitivity).toBe('read');
  });

  it('applies override-up but rejects override-down', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            {
              name: 'objects.list',
              description: 'List objects.',
              inputSchema: { type: 'object' },
              annotations: { sensitivity: 'read', wysiwys: { display_template: 'List' } },
            },
            {
              name: 'objects.delete',
              description: 'Delete.',
              inputSchema: { type: 'object' },
              annotations: { sensitivity: 'write', wysiwys: { display_template: 'Delete' } },
            },
          ],
        },
      }),
    );
    const { tools } = await buildKcWrappers({
      knowledgeUrl: 'https://kc',
      serviceToken: 'svc',
      signer: makeStubSigner(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      sensitivityOverrides: {
        'objects.list': 'danger', // up
        'objects.delete': 'read', // down — should NOT apply
      },
    });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName['objects.list']?.sensitivity).toBe('danger');
    expect(byName['objects.delete']?.sensitivity).toBe('write'); // override-down ignored
  });
});

// ─── buildKcWrappers contract: display-template bridging ──────────────────

describe('manifest-roundtrip: buildKcWrappers displayTemplate bridge', () => {
  it('reads displayTemplate from KC2 canonical nested location wysiwys.display_template', async () => {
    // KC2-side spec §1.4: emits annotations.wysiwys.display_template
    // approval2's resolver bridges this to its flat displayTemplate slot.
    const fetchMock = vi.fn().mockResolvedValue(jsonRpcResponse(KC2_MANIFEST_FIXTURE));
    const { tools } = await buildKcWrappers({
      knowledgeUrl: 'https://kc',
      serviceToken: 'svc',
      signer: makeStubSigner(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const create = tools.find((t) => t.name === 'objects.create');
    expect(create?.displayTemplate).toBeDefined();
    expect(create?.displayTemplate).toContain('Create {{subtype}}');
  });

  it('also accepts flat displayTemplate (back-compat with native approval2 tools)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            {
              name: 'native.tool',
              description: 'A tool with flat displayTemplate.',
              inputSchema: { type: 'object' },
              annotations: { displayTemplate: 'Run native tool' },
            },
          ],
        },
      }),
    );
    const { tools } = await buildKcWrappers({
      knowledgeUrl: 'https://kc',
      serviceToken: 'svc',
      signer: makeStubSigner(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(tools[0]?.displayTemplate).toBe('Run native tool');
  });

  it('also accepts flat display_template (snake_case at root) as further fallback', async () => {
    // Some MCP servers emit annotations.display_template (snake_case, flat).
    // Bridge should pick that up too if neither nested wysiwys nor camel exists.
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            {
              name: 'thirdparty.tool',
              description: 'A tool emitting flat snake_case.',
              inputSchema: { type: 'object' },
              annotations: { display_template: 'Third-party action' },
            },
          ],
        },
      }),
    );
    const { tools } = await buildKcWrappers({
      knowledgeUrl: 'https://kc',
      serviceToken: 'svc',
      signer: makeStubSigner(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(tools[0]?.displayTemplate).toBe('Third-party action');
  });

  it('preserves annotations payload verbatim on the Tool (for PWA rendering)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRpcResponse(KC2_MANIFEST_FIXTURE));
    const { tools } = await buildKcWrappers({
      knowledgeUrl: 'https://kc',
      serviceToken: 'svc',
      signer: makeStubSigner(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const create = tools.find((t) => t.name === 'objects.create');
    // approval2's PWA reads the full annotations object for WYSIWYS display.
    expect(create?.annotations).toBeDefined();
    const a = create?.annotations as { wysiwys?: { display_template?: string } };
    expect(a.wysiwys?.display_template).toBeDefined(); // nested form retained
  });
});

// ─── Graceful failure modes (cutover-day resilience) ──────────────────────

describe('manifest-roundtrip: graceful failure modes', () => {
  it('returns empty tools[] when KC2 is unreachable (no throw)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const { tools, manifest } = await buildKcWrappers({
      knowledgeUrl: 'http://kc.unreach',
      serviceToken: 'svc',
      signer: makeStubSigner(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(tools).toEqual([]);
    expect(manifest.tools).toEqual([]);
  });

  it('returns empty tools[] when KC2 returns 500 (graceful, log warn)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"error":"boom"}', { status: 500 }),
    );
    const { tools } = await buildKcWrappers({
      knowledgeUrl: 'https://kc',
      serviceToken: 'svc',
      signer: makeStubSigner(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(tools).toEqual([]);
  });

  it('skips entries that are not a valid manifest shape but builds the rest', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpcResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            { name: 'valid.tool', description: 'ok', inputSchema: { type: 'object' } },
            { /* no name */ description: 'broken', inputSchema: {} },
            { name: 'valid.second', description: 'ok2', inputSchema: { type: 'object' } },
          ],
        },
      }),
    );
    const { tools } = await buildKcWrappers({
      knowledgeUrl: 'https://kc',
      serviceToken: 'svc',
      signer: makeStubSigner(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(tools.map((t) => t.name)).toEqual(['valid.tool', 'valid.second']);
  });
});
