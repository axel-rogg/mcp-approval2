/**
 * Smoke-Tests: prefs / display / native-settings / util / user-extended Tools.
 *
 * Scope: Pro Tool min. 1 Smoke-Test:
 *   - Schema-Validation, falls vorhanden
 *   - execute() liefert sinnvolle Antwort (mit gestubten Deps)
 */
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../mcp/protocol/tool.js';
import type { AuditService } from '../mcp/protocol/tool.js';
import type { AppConfig } from '../lib/config.js';
import {
  makePrefsGetTool,
  makePrefsRemoveTool,
  makePrefsSetTool,
} from './prefs-tools.js';
import { makeDisplayTool } from './display-tools.js';
import { makeNativeSettingsTool } from './native-settings-tools.js';
import { makeUtilNowTool, makeUtilUuidTool } from './util-tools.js';
import { makeUserGetTool, makeUserSetTool } from './user-extended-tools.js';
import type { PrefsService, ToolDefault } from '../services/prefs.js';

const USER_ID = '00000000-0000-0000-0000-000000000001';

function makeAuditStub(): AuditService {
  return { async emit() {} };
}

function makePrefsStub(): PrefsService & { _calls: unknown[] } {
  const calls: unknown[] = [];
  const stored: ToolDefault[] = [];
  return {
    _calls: calls,
    async get(args) {
      calls.push({ op: 'get', args });
      return stored.filter((d) =>
        args.toolName ? d.toolName === args.toolName : true,
      );
    },
    async set(args) {
      calls.push({ op: 'set', args });
      stored.push({
        toolName: args.toolName,
        field: args.field,
        value: args.value,
        scope: args.scope ?? 'user',
      });
    },
    async remove(args) {
      calls.push({ op: 'remove', args });
    },
    async resolveForTool(args) {
      calls.push({ op: 'resolve', args });
      return { resolvedInput: args.userInput, defaultsApplied: [] };
    },
  };
}

function makeUserAwareDbStub(): ToolContext['db'] {
  const row = {
    id: USER_ID,
    externalId: null,
    email: 'axel@example.com',
    displayName: 'Axel',
    role: 'admin' as const,
    status: 'active' as const,
    createdAt: 100,
    lastLoginAt: 200,
    invitedBy: null,
    deletedAt: null,
  };
  const scoped = {
    async query<T>(sql: string): Promise<T[]> {
      if (sql.toLowerCase().includes('select') && sql.toLowerCase().includes('from users')) {
        return [row as unknown as T];
      }
      return [] as T[];
    },
  };
  return {
    dialect: 'postgres' as const,
    async scoped() {
      return scoped;
    },
    unsafe() {
      return scoped;
    },
    async transaction<T>(_uid: string, fn: (sc: typeof scoped) => Promise<T>) {
      return fn(scoped);
    },
  } as unknown as ToolContext['db'];
}

function makeCtx(deps?: { db?: ToolContext['db'] }): ToolContext {
  return {
    userId: USER_ID,
    email: 'axel@example.com',
    role: 'admin',
    requestId: 'req-1',
    audit: makeAuditStub(),
    db: deps?.db ?? makeUserAwareDbStub(),
    signal: new AbortController().signal,
  };
}

function makeAppConfig(): AppConfig {
  return {
    NODE_ENV: 'test',
    PORT: 8787,
    ORIGIN: 'http://localhost:8787',
    DATABASE_URL: 'postgres://stub',
    DATABASE_DIALECT: 'postgres',
    JWT_SECRET: 'x'.repeat(32),
    JWT_ISSUER: 'mcp-approval2',
    JWT_AUDIENCE: 'mcp-approval2-api',
    SESSION_TTL_SEC: 1800,
    REFRESH_TTL_SEC: 30 * 24 * 60 * 60,
    GOOGLE_CLIENT_ID: 'gci',
    GOOGLE_CLIENT_SECRET: 'gcs',
    GOOGLE_REDIRECT_URI: 'http://localhost:8787/auth/google/callback',
    RP_ID: 'localhost',
    RP_NAME: 'mcp-approval2',
    RP_ORIGIN: 'http://localhost:8787',
    INVITE_TTL_SEC: 24 * 60 * 60,
    RECOVERY_TTL_SEC: 24 * 60 * 60,
  } as AppConfig;
}

describe('prefs-tools', () => {
  it('prefs.get returns defaults via service', async () => {
    const prefs = makePrefsStub();
    const tool = makePrefsGetTool({ prefs });
    const result = await tool.execute(makeCtx(), {});
    expect(result.count).toBe(0);
    expect(prefs._calls).toEqual([{ op: 'get', args: { userId: USER_ID } }]);
  });

  it('prefs.get forwards toolName/field filter', async () => {
    const prefs = makePrefsStub();
    const tool = makePrefsGetTool({ prefs });
    await tool.execute(makeCtx(), { toolName: 'docs.put', field: 'tag' });
    expect(prefs._calls[0]).toMatchObject({
      op: 'get',
      args: { userId: USER_ID, toolName: 'docs.put', field: 'tag' },
    });
  });

  it('prefs.set is write + invokes service.set', async () => {
    const prefs = makePrefsStub();
    const tool = makePrefsSetTool({ prefs });
    expect(tool.sensitivity).toBe('write');
    const result = await tool.execute(makeCtx(), {
      toolName: 'docs.put',
      field: 'namespace',
      value: 'work',
    });
    expect(result.toolName).toBe('docs.put');
    expect(result.scope).toBe('user');
    expect(prefs._calls[0]).toMatchObject({
      op: 'set',
      args: { toolName: 'docs.put', field: 'namespace', value: 'work', scope: 'user' },
    });
  });

  it('prefs.set rejects empty toolName via schema', async () => {
    const tool = makePrefsSetTool({ prefs: makePrefsStub() });
    expect(() =>
      tool.inputSchema.parse({ toolName: '', field: 'x', value: 1 }),
    ).toThrow();
  });

  it('prefs.remove is write + invokes service.remove', async () => {
    const prefs = makePrefsStub();
    const tool = makePrefsRemoveTool({ prefs });
    expect(tool.sensitivity).toBe('write');
    const result = await tool.execute(makeCtx(), {
      toolName: 'docs.put',
      field: 'namespace',
    });
    expect(result.scope).toBe('user');
    expect(prefs._calls[0]).toMatchObject({
      op: 'remove',
      args: { toolName: 'docs.put', field: 'namespace', scope: 'user' },
    });
  });
});

describe('display-tool', () => {
  it('returns sections + identity from profile', async () => {
    const tool = makeDisplayTool();
    const result = await tool.execute(makeCtx(), {});
    expect(result.user.email).toBe('axel@example.com');
    expect(result.user.displayName).toBe('Axel');
    expect(result.sections.length).toBeGreaterThan(0);
    expect(result.sections[0]?.label).toBe('Identity');
    expect(result.serverTime).toBeGreaterThan(0);
  });
});

describe('native-settings-tool', () => {
  it('returns origin + webauthn config + auth modes', async () => {
    const tool = makeNativeSettingsTool({ config: makeAppConfig() });
    const result = await tool.execute(makeCtx(), {});
    expect(result.service).toBe('mcp-approval2');
    expect(result.origin).toBe('http://localhost:8787');
    expect(result.webauthn.rpId).toBe('localhost');
    expect(result.auth.modes).toContain('google_oauth');
    expect(result.auth.modes).toContain('webauthn');
    expect(result.auth.sessionTtlSec).toBe(1800);
  });

  it('does NOT leak JWT_SECRET', async () => {
    const tool = makeNativeSettingsTool({ config: makeAppConfig() });
    const result = await tool.execute(makeCtx(), {});
    expect(JSON.stringify(result)).not.toContain('x'.repeat(32));
  });
});

describe('util-tools', () => {
  it('util.now returns Unix-ms + ISO string', async () => {
    const tool = makeUtilNowTool();
    const result = await tool.execute(makeCtx(), {});
    expect(typeof result.unixMs).toBe('number');
    expect(result.unixMs).toBeGreaterThan(0);
    expect(result.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.timezone).toBe('UTC');
  });

  it('util.uuid generates n UUIDs (default 1)', async () => {
    const tool = makeUtilUuidTool();
    const r1 = await tool.execute(makeCtx(), {});
    expect(r1.uuids).toHaveLength(1);
    expect(r1.uuids[0]).toMatch(/^[0-9a-f-]{36}$/);
    const r3 = await tool.execute(makeCtx(), { count: 3 });
    expect(r3.uuids).toHaveLength(3);
    expect(new Set(r3.uuids).size).toBe(3); // all unique
  });

  it('util.uuid rejects count > 100', () => {
    const tool = makeUtilUuidTool();
    expect(() => tool.inputSchema.parse({ count: 101 })).toThrow();
  });
});

describe('user-extended-tools', () => {
  it('user.get returns mini-DTO', async () => {
    const tool = makeUserGetTool();
    const result = await tool.execute(makeCtx(), {});
    expect(result).toMatchObject({
      id: USER_ID,
      email: 'axel@example.com',
      displayName: 'Axel',
      role: 'admin',
    });
  });

  it('user.set is write + requires at least one field', () => {
    const tool = makeUserSetTool();
    expect(tool.sensitivity).toBe('write');
    expect(() => tool.inputSchema.parse({})).toThrow();
  });
});
