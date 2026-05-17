/**
 * Tests fuer kc-manifest-refresh cron task — A9.
 *
 * Plan-Ref: PLAN-as3-autonomous.md §1.4 + A9.
 *
 * Scope:
 *   - Noop wenn kcManifest deps fehlen
 *   - Diff: added/removed sind korrekt gegenueber previousTools
 *   - Bei KC2-Unreach (empty manifest, previousTools nicht leer): noop,
 *     bestehende Tools bleiben in Registry
 *   - Bei Failure: error-Result + audit, alte Tools NICHT entfernen
 */
import { describe, it, expect, vi } from 'vitest';
import type { DbAdapter, JwtSigner } from '@mcp-approval2/adapters';
import { ToolRegistry } from '../mcp/protocol/registry.js';
import type { Tool } from '../mcp/protocol/tool.js';
import { runKcManifestRefresh } from './kc-manifest-refresh.js';
import type { BuildKcWrappersOpts } from '../tools/kc_wrappers/index.js';

function makeDbStub(): DbAdapter {
  const scoped = {
    async query() {
      return [];
    },
    drizzle: {} as unknown,
  };
  return {
    dialect: 'postgres' as const,
    async scoped() {
      return { ...scoped, userId: 'stub', dialect: 'postgres' as const };
    },
    unsafe() {
      return { ...scoped, dialect: 'postgres' as const };
    },
    async transaction<T>(_uid: string, fn: (sc: typeof scoped) => Promise<T>): Promise<T> {
      return fn(scoped);
    },
    async migrate() {},
    async close() {},
  } as unknown as DbAdapter;
}

function makeSigner(): JwtSigner {
  return {
    sign: vi.fn().mockResolvedValue('unused'),
    signOBO: vi.fn().mockResolvedValue('obo'),
  };
}

function jsonResp(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makePreviousTool(name: string): Tool<unknown, unknown> {
  return {
    name,
    description: `prev ${name}`,
    sensitivity: 'write',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputSchema: { parse: (v: unknown) => v } as any,
    async execute() {
      return [];
    },
  };
}

describe('kc-manifest-refresh', () => {
  it('noop when kcManifest deps missing', async () => {
    const db = makeDbStub();
    const result = await runKcManifestRefresh({ db });
    expect(result.tools_count).toBe(0);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it('adds new tools + removes vanished ones', async () => {
    const db = makeDbStub();
    const registry = new ToolRegistry();
    const previousTools = [makePreviousTool('objects.create'), makePreviousTool('objects.list')];
    // Initial state: previous tools sind in registry.
    for (const t of previousTools) registry.register(t);

    // KC2 antwortet jetzt mit 1 alten + 1 neuen → 'objects.list' verschwindet.
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResp({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            {
              name: 'objects.create',
              description: 'C',
              inputSchema: { type: 'object' },
              annotations: { write: true },
            },
            {
              name: 'objects.share',
              description: 'S',
              inputSchema: { type: 'object' },
              annotations: { write: true },
            },
          ],
        },
      }),
    );
    const previousOpts: BuildKcWrappersOpts = {
      knowledgeUrl: 'https://kc',
      serviceToken: 'tok',
      signer: makeSigner(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    };
    const cacheCallback = vi.fn();
    const result = await runKcManifestRefresh({
      db,
      kcManifest: {
        registry,
        previousOpts,
        previousTools,
        onUpdated: cacheCallback,
      },
    });
    expect(result.tools_count).toBe(2);
    expect(result.added).toBe(1); // objects.share
    expect(result.removed).toBe(1); // objects.list
    expect(registry.has('objects.create')).toBe(true);
    expect(registry.has('objects.share')).toBe(true);
    expect(registry.has('objects.list')).toBe(false);
    expect(cacheCallback).toHaveBeenCalledTimes(1);
  });

  it('noop when KC2 returns empty manifest (keep existing)', async () => {
    const db = makeDbStub();
    const registry = new ToolRegistry();
    const previousTools = [makePreviousTool('objects.create')];
    registry.register(previousTools[0]!);

    // Empty result (KC2 transient).
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResp({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
    );
    const cacheCallback = vi.fn();
    const result = await runKcManifestRefresh({
      db,
      kcManifest: {
        registry,
        previousOpts: {
          knowledgeUrl: 'https://kc',
          serviceToken: 'tok',
          signer: makeSigner(),
          fetchImpl: fetchMock as unknown as typeof fetch,
        },
        previousTools,
        onUpdated: cacheCallback,
      },
    });
    expect(result.tools_count).toBe(1); // previous count preserved
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(registry.has('objects.create')).toBe(true);
    expect(cacheCallback).not.toHaveBeenCalled();
  });

  it('keeps tools on KC2 fetch failure', async () => {
    const db = makeDbStub();
    const registry = new ToolRegistry();
    const previousTools = [makePreviousTool('objects.create')];
    registry.register(previousTools[0]!);

    // buildKcWrappers behandelt fetch-Failure intern graceful (logs +
    // returns empty). Wir simulieren also einen network error im fetch.
    // Aus runKcManifestRefresh-Sicht wirkt das wie "empty manifest" →
    // same "keep existing"-Pfad.
    const fetchMock = vi.fn().mockRejectedValue(new Error('boom'));
    const result = await runKcManifestRefresh({
      db,
      kcManifest: {
        registry,
        previousOpts: {
          knowledgeUrl: 'https://kc',
          serviceToken: 'tok',
          signer: makeSigner(),
          fetchImpl: fetchMock as unknown as typeof fetch,
        },
        previousTools,
        onUpdated: vi.fn(),
      },
    });
    expect(result.removed).toBe(0);
    expect(registry.has('objects.create')).toBe(true);
  });
});
