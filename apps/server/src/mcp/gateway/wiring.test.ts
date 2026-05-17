/**
 * Unit-Tests: Sub-MCP-Wiring (user-JWT signer, wrapper-tool factory, CF-Seed).
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.4, §9.
 */
import { describe, it, expect } from 'vitest';
import { jwtVerify } from 'jose';
import type { DbAdapter, RawDb, ScopedDb } from '@mcp-approval2/adapters';
import { signSubMcpUserJwt } from './user_jwt.js';
import {
  buildSubMcpWrapperTools,
  makeForwardingTool,
  resolveSubMcpSensitivity,
} from './wrapper_tools.js';
import { DEFAULT_SATELLITE_WORKERS, seedSatelliteWorkers } from './seed_satellites.js';
import {
  DEFAULT_OAUTH_CATALOG_SERVERS,
  seedOAuthCatalogServers,
} from './seed_oauth_catalog.js';
import { SubMcpForwarder } from './forwarder.js';
import { SubMcpNotFoundError, type SubMcpServerConfig } from './types.js';
import type { ToolContext } from '../protocol/tool.js';
import type { SubMcpRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// user_jwt
// ---------------------------------------------------------------------------

describe('signSubMcpUserJwt', () => {
  const config = { JWT_SECRET: 'a'.repeat(32), JWT_ISSUER: 'mcp-approval2' };

  it('signs HS256 with sub/aud/iss + 60s default expiry', async () => {
    const token = await signSubMcpUserJwt({
      userId: 'u-123',
      subMcpName: 'gws',
      config,
    });
    const { payload, protectedHeader } = await jwtVerify(
      token,
      new TextEncoder().encode(config.JWT_SECRET),
      { issuer: 'mcp-approval2', audience: 'gws', algorithms: ['HS256'] },
    );
    expect(protectedHeader.alg).toBe('HS256');
    expect(payload.sub).toBe('u-123');
    expect(payload.aud).toBe('gws');
    expect(payload.iss).toBe('mcp-approval2');
    expect(typeof payload.exp).toBe('number');
    expect(typeof payload.iat).toBe('number');
    const exp = payload.exp as number;
    const iat = payload.iat as number;
    expect(exp - iat).toBe(60);
  });

  it('honours custom ttlSec', async () => {
    const token = await signSubMcpUserJwt({
      userId: 'u-1',
      subMcpName: 'utils',
      config,
      ttlSec: 10,
    });
    const { payload } = await jwtVerify(token, new TextEncoder().encode(config.JWT_SECRET), {
      audience: 'utils',
    });
    const exp = payload.exp as number;
    const iat = payload.iat as number;
    expect(exp - iat).toBe(10);
  });

  it('verifies-fail for wrong audience (replay-protection across sub-MCPs)', async () => {
    const token = await signSubMcpUserJwt({
      userId: 'u-1',
      subMcpName: 'gws',
      config,
    });
    await expect(
      jwtVerify(token, new TextEncoder().encode(config.JWT_SECRET), { audience: 'gcloud' }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveSubMcpSensitivity — fail-closed default 'write' (SEC-006-Pattern)
// ---------------------------------------------------------------------------

describe('resolveSubMcpSensitivity', () => {
  it('defaults to write when no annotations', () => {
    expect(resolveSubMcpSensitivity(undefined)).toBe('write');
  });

  it('defaults to write when empty annotations', () => {
    expect(resolveSubMcpSensitivity({} as never)).toBe('write');
  });

  it('respects explicit sensitivity=read', () => {
    expect(resolveSubMcpSensitivity({ sensitivity: 'read' } as never)).toBe('read');
  });

  it('respects explicit sensitivity=write', () => {
    expect(resolveSubMcpSensitivity({ sensitivity: 'write' } as never)).toBe('write');
  });

  it('respects explicit sensitivity=danger', () => {
    expect(resolveSubMcpSensitivity({ sensitivity: 'danger' } as never)).toBe('danger');
  });

  it('ignores unknown sensitivity strings (fail-closed)', () => {
    expect(resolveSubMcpSensitivity({ sensitivity: 'medium' } as never)).toBe('write');
  });

  it('destructiveHint=true → danger', () => {
    expect(resolveSubMcpSensitivity({ destructiveHint: true } as never)).toBe('danger');
  });

  it('write=true → write', () => {
    expect(resolveSubMcpSensitivity({ write: true } as never)).toBe('write');
  });

  it('readOnlyHint=true → read', () => {
    expect(resolveSubMcpSensitivity({ readOnlyHint: true } as never)).toBe('read');
  });

  it('sensitivity wins over hints when both present', () => {
    expect(
      resolveSubMcpSensitivity({ sensitivity: 'read', destructiveHint: true } as never),
    ).toBe('read');
  });
});

// ---------------------------------------------------------------------------
// makeForwardingTool — wraps forwarder + signs JWT in execute
// ---------------------------------------------------------------------------

function makeStubRegistry(cfg: SubMcpServerConfig): SubMcpRegistry {
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

const STUB_CFG: SubMcpServerConfig = {
  id: 'id-utils',
  name: 'utils',
  displayName: 'Utils',
  baseUrl: 'https://utils.test',
  authMode: 'service_bearer',
  authConfig: { service_token_hash: 'hash' },
  enabled: true,
  serviceToken: 'plain-token',
  toolsCache: [
    {
      name: 'now',
      description: 'Return current time',
      annotations: { sensitivity: 'read' as const },
    },
    {
      name: 'diagram.render',
      description: 'Render a diagram',
      annotations: { destructiveHint: false, write: true },
    },
  ],
  toolsCachedAt: 1,
  createdAt: 1,
  updatedAt: 1,
};

const TEST_CONFIG = { JWT_SECRET: 'b'.repeat(32), JWT_ISSUER: 'mcp-approval2' };

function makeTestCtx(): ToolContext {
  return {
    userId: 'u-1',
    email: 'u@example.com',
    role: 'admin',
    requestId: 'req-1',
    audit: { async emit() {} },
    db: undefined as unknown as DbAdapter,
    signal: new AbortController().signal,
  };
}

describe('makeForwardingTool', () => {
  it('builds a Tool with correct name + sensitivity from annotations', () => {
    const tool = makeForwardingTool({
      def: {
        name: 'utils.now',
        remoteName: 'now',
        subMcpName: 'utils',
        description: 'Return current time',
        inputSchema: { type: 'object' } as never,
        annotations: { sensitivity: 'read' as const },
      },
      forwarder: new SubMcpForwarder({ registry: makeStubRegistry(STUB_CFG), fetchImpl: fetch }),
      config: TEST_CONFIG,
    });
    expect(tool.name).toBe('utils.now');
    expect(tool.sensitivity).toBe('read');
    expect(tool.description).toBe('Return current time');
  });

  it('execute() signs user-JWT + forwards to remote with X-User-JWT header', async () => {
    const captured: { url?: string; headers?: Record<string, string>; body?: unknown } = {};
    const fakeFetch: typeof fetch = async (url, init) => {
      captured.url = String(url);
      captured.headers = (init?.headers as Record<string, string>) ?? {};
      captured.body = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: '1', result: { content: [{ type: 'text', text: 'ok' }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const forwarder = new SubMcpForwarder({
      registry: makeStubRegistry(STUB_CFG),
      fetchImpl: fakeFetch,
    });
    const tool = makeForwardingTool({
      def: {
        name: 'utils.now',
        remoteName: 'now',
        subMcpName: 'utils',
        description: 'Return current time',
        inputSchema: { type: 'object' } as never,
      },
      forwarder,
      config: TEST_CONFIG,
    });
    const result = await tool.execute(makeTestCtx(), { tz: 'UTC' });

    expect(captured.url).toBe('https://utils.test/mcp');
    expect(captured.headers?.authorization).toBe('Bearer plain-token');
    expect(typeof captured.headers?.['x-user-jwt']).toBe('string');
    // user-jwt has correct aud
    const userJwt = captured.headers?.['x-user-jwt'] ?? '';
    const { payload } = await jwtVerify(userJwt, new TextEncoder().encode(TEST_CONFIG.JWT_SECRET), {
      audience: 'utils',
    });
    expect(payload.sub).toBe('u-1');
    expect(payload.aud).toBe('utils');
    // payload args round-tripped
    const body = captured.body as { method: string; params: { name: string; arguments: unknown } };
    expect(body.method).toBe('tools/call');
    expect(body.params.name).toBe('now');
    expect(body.params.arguments).toEqual({ tz: 'UTC' });
    // result returned verbatim
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('defaults to write when annotations missing (fail-closed SEC-006-pattern)', () => {
    const tool = makeForwardingTool({
      def: {
        name: 'gws.calendar.list',
        remoteName: 'calendar.list',
        subMcpName: 'gws',
        description: 'List calendars',
        inputSchema: { type: 'object' } as never,
      },
      forwarder: new SubMcpForwarder({ registry: makeStubRegistry(STUB_CFG), fetchImpl: fetch }),
      config: TEST_CONFIG,
    });
    expect(tool.sensitivity).toBe('write');
  });
});

// ---------------------------------------------------------------------------
// buildSubMcpWrapperTools — iterate registry + per-server counts
// ---------------------------------------------------------------------------

describe('buildSubMcpWrapperTools', () => {
  it('builds wrappers per enabled sub-mcp + skips empty caches', async () => {
    const multi = makeStubRegistry(STUB_CFG);
    // Override listEnabled to return two configs
    const both = await new Promise<readonly SubMcpServerConfig[]>((resolve) => {
      resolve([
        STUB_CFG,
        { ...STUB_CFG, id: 'id-empty', name: 'gws', toolsCache: null },
      ]);
    });
    const stub: SubMcpRegistry = {
      ...multi,
      async listEnabled() {
        return both;
      },
    };
    const result = await buildSubMcpWrapperTools({
      registry: stub,
      forwarder: new SubMcpForwarder({ registry: stub, fetchImpl: fetch }),
      config: TEST_CONFIG,
    });
    expect(result.tools.map((t) => t.name).sort()).toEqual([
      'utils.diagram.render',
      'utils.now',
    ]);
    expect(result.perSubMcp.get('utils')).toBe(2);
    expect(result.perSubMcp.get('gws')).toBe(0);
    expect(result.skipped).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// seedSatelliteWorkers — idempotent INSERT/UPDATE per env-var
// ---------------------------------------------------------------------------

interface CapturedSql {
  sql: string;
  params: ReadonlyArray<unknown>;
}

function makeStubDb(
  responses: ReadonlyArray<ReadonlyArray<unknown>>,
): { db: DbAdapter; captured: CapturedSql[] } {
  const captured: CapturedSql[] = [];
  let callIdx = 0;

  const rawDb: RawDb = {
    async query<T>(sql: string, params?: ReadonlyArray<unknown>): Promise<T[]> {
      captured.push({ sql, params: params ?? [] });
      const out = responses[callIdx] ?? [];
      callIdx += 1;
      return out as T[];
    },
  };
  const db: DbAdapter = {
    unsafe: () => rawDb,
    scoped: () => {
      throw new Error('scoped not used in seed.ts');
    },
    transaction: () => {
      throw new Error('tx not used in seed.ts');
    },
  } as unknown as DbAdapter;
  return { db, captured };
}

describe('seedSatelliteWorkers', () => {
  it('registers catalog-defaults even without env-tokens (registeredWithoutToken)', async () => {
    // Phase 2 PLAN-per-user-server-store: Catalog-Defaults werden IMMER
    // angelegt damit "Verfuegbar"-Liste in der PWA sichtbar ist. Token-
    // Lookup laeuft zur Laufzeit (env-fallback oder user_sub_mcp_config).
    const { db, captured } = makeStubDb([
      [{ name: 'gcloud', was_new: true }],
      [{ name: 'gws', was_new: true }],
      [{ name: 'utils', was_new: true }],
    ]);
    const result = await seedSatelliteWorkers({ db, env: {} });
    expect(result.registered.sort()).toEqual(['gcloud', 'gws', 'utils']);
    expect(result.registeredWithoutToken.sort()).toEqual(['gcloud', 'gws', 'utils']);
    expect(result.updated).toEqual([]);
    expect(captured).toHaveLength(3);
    // auth_config soll service_token_hash:null tragen wenn kein env-Token
    const authConfig0 = JSON.parse(String(captured[0]?.params[3])) as { service_token_hash: string | null };
    expect(authConfig0.service_token_hash).toBeNull();
  });

  it('INSERTs new row with hash when env-var set', async () => {
    const { db, captured } = makeStubDb([
      [{ name: 'gcloud', was_new: true }],
      [{ name: 'gws', was_new: true }],
      [{ name: 'utils', was_new: true }],
    ]);
    const result = await seedSatelliteWorkers({
      db,
      env: { SUB_MCP_TOKEN_UTILS: 'plain-utils-token' },
    });
    expect(result.registered.sort()).toEqual(['gcloud', 'gws', 'utils']);
    // gcloud + gws ohne Token: registeredWithoutToken; utils mit Token
    expect(result.registeredWithoutToken.sort()).toEqual(['gcloud', 'gws']);
    expect(captured).toHaveLength(3);
    const utilsCall = captured.find((c) => c.params[0] === 'utils');
    expect(utilsCall).toBeDefined();
    const utilsAuth = JSON.parse(String(utilsCall?.params[3])) as { service_token_hash: string };
    expect(utilsAuth.service_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(utilsAuth.service_token_hash).not.toBe('plain-utils-token');
  });

  it('reports updated when ON CONFLICT branch fires with was_new=false', async () => {
    const { db } = makeStubDb([
      [{ name: 'gcloud', was_new: false }],
      [{ name: 'gws', was_new: false }],
      [{ name: 'utils', was_new: false }],
    ]);
    const result = await seedSatelliteWorkers({ db, env: {} });
    expect(result.registered).toEqual([]);
    expect(result.updated.sort()).toEqual(['gcloud', 'gws', 'utils']);
  });

  it('treats empty INSERT return as already-in-sync', async () => {
    const { db } = makeStubDb([[], [], []]);
    const result = await seedSatelliteWorkers({ db, env: {} });
    expect(result.registered).toEqual([]);
    expect(result.updated).toEqual([]);
  });

  it('DEFAULT_SATELLITE_WORKERS contains the three expected entries with correct URLs', () => {
    expect(DEFAULT_SATELLITE_WORKERS).toHaveLength(3);
    const byName = new Map(DEFAULT_SATELLITE_WORKERS.map((g) => [g.name, g]));
    expect(byName.get('utils')?.baseUrl).toBe('https://mcp-utils.axelrogg.workers.dev');
    expect(byName.get('gws')?.baseUrl).toBe('https://mcp-gws.axelrogg.workers.dev');
    expect(byName.get('gcloud')?.baseUrl).toBe('https://mcp-gcloud.axelrogg.workers.dev');
    expect(byName.get('utils')?.serviceTokenEnvVar).toBe('SUB_MCP_TOKEN_UTILS');
    expect(byName.get('gws')?.serviceTokenEnvVar).toBe('SUB_MCP_TOKEN_GWS');
    expect(byName.get('gcloud')?.serviceTokenEnvVar).toBe('SUB_MCP_TOKEN_GCLOUD');
  });

  it('gws + gcloud declare inner-OAuth (kind=shared-app) with Google endpoints', () => {
    const byName = new Map(DEFAULT_SATELLITE_WORKERS.map((g) => [g.name, g]));
    const gws = byName.get('gws');
    expect(gws?.innerOAuth?.kind).toBe('shared-app');
    expect(gws?.innerOAuth?.provider).toBe('google');
    expect(gws?.innerOAuth?.authorize_url).toContain('accounts.google.com');
    expect(gws?.innerOAuth?.scopes).toContain(
      'https://www.googleapis.com/auth/calendar',
    );
    expect(gws?.innerOAuth?.scopes).toContain(
      'https://www.googleapis.com/auth/gmail.modify',
    );

    const gcloud = byName.get('gcloud');
    expect(gcloud?.innerOAuth?.kind).toBe('shared-app');
    expect(gcloud?.innerOAuth?.scopes).toContain(
      'https://www.googleapis.com/auth/cloud-platform',
    );
    expect(gcloud?.configFields?.find((f) => f.key === '_service_account_json')).toBeDefined();
    expect(gcloud?.configFields?.find((f) => f.key === '_gcp_project_id')).toBeDefined();

    // utils hat keinen inner-OAuth (eigener Worker mit eigener Logik)
    expect(byName.get('utils')?.innerOAuth).toBeUndefined();
  });

  it('writes config_schema.oauth (top-level) for gws + gcloud at seed time', async () => {
    const { db, captured } = makeStubDb([
      [{ name: 'gcloud', was_new: true }],
      [{ name: 'gws', was_new: true }],
      [{ name: 'utils', was_new: true }],
    ]);
    await seedSatelliteWorkers({ db, env: {} });
    expect(captured).toHaveLength(3);

    const gwsCall = captured.find((c) => c.params[0] === 'gws');
    expect(gwsCall).toBeDefined();
    // param[5] = config_schema JSON (top-level oauth, NICHT _meta.oauth —
    // PWA + UserServerOAuthService lesen top-level, siehe seed_oauth_catalog.ts)
    const gwsSchema = JSON.parse(String(gwsCall?.params[5])) as {
      oauth: { kind: string; provider: string; scopes: string[] };
    };
    expect(gwsSchema.oauth.kind).toBe('shared-app');
    expect(gwsSchema.oauth.provider).toBe('google');
    expect(gwsSchema.oauth.scopes).toContain(
      'https://www.googleapis.com/auth/calendar',
    );

    // gcloud hat oauth + config_fields
    const gcloudCall = captured.find((c) => c.params[0] === 'gcloud');
    const gcloudSchema = JSON.parse(String(gcloudCall?.params[5])) as {
      oauth: { scopes: string[] };
      config_fields: Array<{ key: string }>;
    };
    expect(gcloudSchema.oauth.scopes).toContain(
      'https://www.googleapis.com/auth/cloud-platform',
    );
    expect(gcloudSchema.config_fields.map((f) => f.key)).toContain(
      '_service_account_json',
    );

    // utils hat KEIN inner-OAuth → config_schema sollte null sein
    const utilsCall = captured.find((c) => c.params[0] === 'utils');
    expect(utilsCall?.params[5]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// seedOAuthCatalogServers — Catalog-OAuth-Server (cf)
// github bewusst NICHT im Catalog (User-Decision 2026-05-18 — bleibt
// per-User managed, kein Boot-Seed der die existing Config ueberschreibt).
// ---------------------------------------------------------------------------

describe('seedOAuthCatalogServers', () => {
  it('DEFAULT_OAUTH_CATALOG_SERVERS contains only cf (dcr) — github bleibt user-managed', () => {
    expect(DEFAULT_OAUTH_CATALOG_SERVERS).toHaveLength(1);
    const byName = new Map(DEFAULT_OAUTH_CATALOG_SERVERS.map((s) => [s.name, s]));

    const cf = byName.get('cf');
    expect(cf?.oauthKind).toBe('dcr');
    expect(cf?.baseUrl).toBe('https://bindings.mcp.cloudflare.com/sse');
    expect(cf?.oauthMeta.provider).toBe('cloudflare');
    expect(cf?.oauthMeta.registration_endpoint).toBeDefined();

    // github darf nicht in Catalog — sonst wuerde Boot den per-User Setup ueberschreiben
    expect(byName.get('github')).toBeUndefined();
  });

  it('inserts cf as catalog-default with auth_mode=oauth + top-level oauth schema', async () => {
    const { db, captured } = makeStubDb([[{ name: 'cf', was_new: true }]]);
    const result = await seedOAuthCatalogServers({ db });
    expect(result.registered).toEqual(['cf']);
    expect(result.updated).toEqual([]);
    expect(captured).toHaveLength(1);

    const insert = captured[0];
    expect(insert).toBeDefined();
    expect(String(insert?.sql)).toContain("'oauth'");
    // config_schema liegt in params[4] und enthaelt TOP-LEVEL `oauth`
    // (NICHT `_meta.oauth`) — aligned mit user-server-oauth.ts:getOAuthSchema()
    // und der PWA.
    const cfgSchema = JSON.parse(String(insert?.params[4])) as {
      oauth: { kind: string; authorize_url: string; token_url: string };
    };
    expect(cfgSchema.oauth.kind).toBe('dcr');
    expect(cfgSchema.oauth.authorize_url).toContain('cloudflare.com');
    expect(cfgSchema.oauth.token_url).toContain('cloudflare.com');
  });

  it('reports updated when ON CONFLICT branch fires with was_new=false', async () => {
    const { db } = makeStubDb([[{ name: 'cf', was_new: false }]]);
    const result = await seedOAuthCatalogServers({ db });
    expect(result.registered).toEqual([]);
    expect(result.updated).toEqual(['cf']);
  });

  it('idempotent: empty INSERT-return means already-in-sync', async () => {
    const { db } = makeStubDb([[]]);
    const result = await seedOAuthCatalogServers({ db });
    expect(result.registered).toEqual([]);
    expect(result.updated).toEqual([]);
  });
});

// Suppress unused-warning for ScopedDb-import (kept for symmetry with other tests)
type _Unused = ScopedDb;
