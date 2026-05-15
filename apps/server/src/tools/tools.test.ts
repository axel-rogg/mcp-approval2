/**
 * Smoke-Tests: Core-Tools (system, user, knowledge, credentials).
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Burst 3.
 *
 * Fuer jeden Tool wird geprueft:
 *   - Tool ist registriert
 *   - Schema-Validation greift bei invalidem Input
 *   - Read-Dispatch funktioniert (mocked Services)
 *   - Write/Danger: dispatch wirft ApprovalRequiredError ohne bypass
 *   - credentials.add: ohne prfSessionId wirft PrfRequiredError
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  KnowledgeAdapter,
  KnowledgeObject,
  ObjectsList,
  SearchHit,
  Share,
} from '@mcp-approval2/adapters';
import {
  ApprovalRequiredError,
  ToolInputValidationError,
  ToolRegistry,
} from '../mcp/protocol/registry.js';
import type { AuditService, ToolContext } from '../mcp/protocol/tool.js';
import { KnowledgeService } from '../services/knowledge.js';
import {
  PrfRequiredError,
  type CredentialMeta,
  type CredentialsService,
} from '../services/credentials.js';
import { InMemoryPrfSessionService } from '../services/prf-session.js';
import { registerCoreTools, type ToolDeps } from './index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = '00000000-0000-0000-0000-000000000001';

function makeAuditStub(): AuditService & { events: Array<{ action: string; result: string }> } {
  const events: Array<{ action: string; result: string }> = [];
  return {
    events,
    async emit(event) {
      events.push({ action: event.action, result: event.result });
    },
  };
}

function makeStubObject(overrides: Partial<KnowledgeObject> = {}): KnowledgeObject {
  return {
    id: 'obj-1',
    ownerId: USER_ID,
    subtype: 'doc',
    title: 'Stub',
    description: 'stub doc',
    keywords: [],
    triggerHints: null,
    meta: null,
    bodySize: 9,
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

function makeKnowledgeAdapterStub(): KnowledgeAdapter {
  const obj = makeStubObject();
  const skill = makeStubObject({ id: 'skill-1', subtype: 'skill_manifest', title: 'My Skill' });
  const docList: ObjectsList = { items: [obj], nextCursor: null };
  const skillList: ObjectsList = { items: [skill], nextCursor: null };
  const hits: ReadonlyArray<SearchHit> = [
    {
      id: 'obj-1',
      subtype: 'doc',
      title: 'Stub',
      score: 0.42,
      ftsRank: 0.4,
      vectorScore: 0.3,
    },
  ];
  const share: Share = {
    id: 'share-1',
    resourceId: 'obj-1',
    grantedBy: USER_ID,
    grantedTo: 'user-2',
    scope: 'read',
    grantedAt: 1,
    expiresAt: null,
    revokedAt: null,
  };
  return {
    async createObject(args) {
      return makeStubObject({ id: 'new-obj', subtype: args.subtype ?? null, title: args.title ?? null });
    },
    async getObject() {
      return obj;
    },
    async listObjects(args) {
      return args.subtype === 'skill_manifest' ? skillList : docList;
    },
    async updateObject() {
      return obj;
    },
    async deleteObject() {
      /* noop */
    },
    async createShare() {
      return share;
    },
    async listShares() {
      return [share];
    },
    async revokeShare() {
      /* noop */
    },
    async search() {
      return hits;
    },
    async eraseUser() {
      return {
        status: 'ok',
        deleted: {
          objects: 0,
          shares: 0,
          idempotency: 0,
          uploads: 0,
          auditPseudonymised: 0,
          blobsDeleted: 0,
          blobsPending: 0,
        },
        deletedRows: 0,
      };
    },
    async syncUser() {
      return { status: 'created', kcUserId: 'kc-stub-1' };
    },
  };
}

function makeCredentialsStub(): CredentialsService {
  const meta: CredentialMeta = {
    id: 'cred-1',
    ownerId: USER_ID,
    provider: 'github',
    kind: 'api_token',
    label: 'default',
    prfEnabled: true,
    prfCredentialId: null,
    metadata: null,
    createdAt: 1,
    rotatedAt: null,
    lastUsedAt: null,
    expiresAt: null,
  };
  return {
    async create() {
      return meta;
    },
    async read() {
      return { secret: 'shh', meta };
    },
    async list() {
      return [meta];
    },
    async rotate() {
      /* noop */
    },
    async delete() {
      /* noop */
    },
    async resolveForSubMcp() {
      return { secret: 'shh', expiresAt: null };
    },
  };
}

function makeUserAwareDbStub(initialRow: {
  id: string;
  email: string;
  displayName: string;
}): {
  // Minimal-Stub: nur was die User-Tools verwenden.
  db: ToolContext['db'];
  state: { displayName: string; email: string };
} {
  const state = { displayName: initialRow.displayName, email: initialRow.email };
  const scoped = {
    async query<T>(sql: string, params?: ReadonlyArray<unknown>): Promise<T[]> {
      const lower = sql.toLowerCase();
      if (lower.includes('update users set display_name')) {
        state.displayName = String(params?.[0] ?? state.displayName);
        return [] as T[];
      }
      if (lower.includes('update users set email')) {
        state.email = String(params?.[0] ?? state.email);
        return [] as T[];
      }
      if (lower.includes('select') && lower.includes('from users')) {
        const row = {
          id: initialRow.id,
          externalId: null,
          email: state.email,
          displayName: state.displayName,
          role: 'member' as const,
          status: 'active' as const,
          createdAt: 100,
          lastLoginAt: 200,
          invitedBy: null,
          deletedAt: null,
        };
        return [row as unknown as T];
      }
      return [] as T[];
    },
  };
  const db = {
    async scoped() {
      return scoped;
    },
    unsafe() {
      return scoped;
    },
    async transaction<T>(_userId: string, fn: (sc: typeof scoped) => Promise<T>): Promise<T> {
      return fn(scoped);
    },
    dialect: 'postgres' as const,
  } as unknown as ToolContext['db'];
  return { db, state };
}

function makeCtx(
  audit: AuditService,
  db: ToolContext['db'],
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    userId: USER_ID,
    email: 'user@example.com',
    role: 'member',
    requestId: 'req-1',
    audit,
    db,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function buildRegistry(
  overrides: Partial<ToolDeps> = {},
): Promise<{ registry: ToolRegistry; deps: ToolDeps; audit: ReturnType<typeof makeAuditStub> }> {
  const audit = makeAuditStub();
  const knowledge = new KnowledgeService({
    adapter: makeKnowledgeAdapterStub(),
    audit,
  });
  const credentials = overrides.credentials ?? makeCredentialsStub();
  const prfSessions = overrides.prfSessions ?? new InMemoryPrfSessionService();
  const deps: ToolDeps = {
    knowledge: overrides.knowledge ?? knowledge,
    credentials,
    prfSessions,
    audit,
  };
  const registry = new ToolRegistry();
  registerCoreTools(registry, deps);
  return { registry, deps, audit };
}

// ===========================================================================
// registerCoreTools
// ===========================================================================

describe('registerCoreTools', () => {
  it('registers all expected tools', async () => {
    const { registry } = await buildRegistry();
    const names = registry.list().map((t) => t.name);
    expect(names).toEqual(
      [
        // System
        'system.echo',
        'system.health',
        // User (canonical + extended DTO)
        'user.profile.read',
        'user.profile.update',
        'user.get',
        'user.set',
        // Knowledge (canonical helpers)
        'knowledge.docs.create',
        'knowledge.docs.list',
        'knowledge.docs.read',
        'knowledge.search',
        'knowledge.skills.list',
        // KC-Wrappers — docs.*
        'docs.put',
        'docs.get',
        'docs.list',
        'docs.delete',
        'docs.usages',
        'docs.attach_to',
        'docs.update_summary',
        // KC-Wrappers — skills.*
        'skills.put',
        'skills.get',
        'skills.list',
        'skills.delete',
        'skills.search',
        'skills.read_resource',
        'skills.attach_resource',
        // KC-Wrappers — memorize.*
        'memorize.add',
        'memorize.search',
        'memorize.list_recent',
        'memorize.delete',
        // KC-Wrappers — objects.*
        'objects.list',
        'objects.read',
        // Credentials
        'credentials.add',
        'credentials.delete',
        'credentials.list',
        // Util
        'util.now',
        'util.uuid',
        // Display
        'display',
      ].sort(),
    );
  });

  it('exposes sensitivity + displayTemplate annotations on write-tools', async () => {
    const { registry } = await buildRegistry();
    const meta = registry.list();
    const writeTool = meta.find((t) => t.name === 'knowledge.docs.create');
    expect(writeTool?.annotations?.sensitivity).toBe('write');
    expect(writeTool?.annotations?.displayTemplate).toContain('Create new document');
    const dangerTool = meta.find((t) => t.name === 'credentials.delete');
    expect(dangerTool?.annotations?.sensitivity).toBe('danger');
    expect(dangerTool?.annotations?.destructiveHint).toBe(true);
  });
});

// ===========================================================================
// system.health + system.echo
// ===========================================================================

describe('system tools', () => {
  it('system.health returns ok with userId+requestId', async () => {
    const { registry, audit } = await buildRegistry();
    const { db } = makeUserAwareDbStub({ id: USER_ID, email: 'a@b.com', displayName: 'A' });
    const ctx = makeCtx(audit, db);
    const res = await registry.dispatch({ name: 'system.health', input: {}, ctx });
    const text = (res.result.content[0] as { text: string }).text;
    expect(text).toContain('"status":"ok"');
    expect(text).toContain(`"userId":"${USER_ID}"`);
  });

  it('system.echo returns echo prefix', async () => {
    const { registry, audit } = await buildRegistry();
    const { db } = makeUserAwareDbStub({ id: USER_ID, email: 'a@b.com', displayName: 'A' });
    const ctx = makeCtx(audit, db);
    const res = await registry.dispatch({ name: 'system.echo', input: { message: 'hi' }, ctx });
    expect((res.result.content[0] as { text: string }).text).toBe('echo: hi');
  });

  it('system.echo: empty message → ToolInputValidationError', async () => {
    const { registry, audit } = await buildRegistry();
    const { db } = makeUserAwareDbStub({ id: USER_ID, email: 'a@b.com', displayName: 'A' });
    const ctx = makeCtx(audit, db);
    await expect(
      registry.dispatch({ name: 'system.echo', input: { message: '' }, ctx }),
    ).rejects.toBeInstanceOf(ToolInputValidationError);
  });
});

// ===========================================================================
// user.profile.*
// ===========================================================================

describe('user.profile tools', () => {
  it('user.profile.read returns DTO via getOwnProfile', async () => {
    const { registry, audit } = await buildRegistry();
    const { db } = makeUserAwareDbStub({
      id: USER_ID,
      email: 'axel@example.com',
      displayName: 'Axel',
    });
    const ctx = makeCtx(audit, db);
    const res = await registry.dispatch({ name: 'user.profile.read', input: {}, ctx });
    const text = (res.result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text) as { id: string; email: string; displayName: string };
    expect(parsed.id).toBe(USER_ID);
    expect(parsed.email).toBe('axel@example.com');
  });

  it('user.profile.update without bypassApproval → ApprovalRequiredError', async () => {
    const { registry, audit } = await buildRegistry();
    const { db } = makeUserAwareDbStub({
      id: USER_ID,
      email: 'a@b.com',
      displayName: 'A',
    });
    const ctx = makeCtx(audit, db);
    await expect(
      registry.dispatch({
        name: 'user.profile.update',
        input: { displayName: 'New Name' },
        ctx,
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('user.profile.update with bypassApproval applies update', async () => {
    const { registry, audit } = await buildRegistry();
    const { db, state } = makeUserAwareDbStub({
      id: USER_ID,
      email: 'a@b.com',
      displayName: 'A',
    });
    const ctx = makeCtx(audit, db);
    await registry.dispatch({
      name: 'user.profile.update',
      input: { displayName: 'New Name', email: 'new@example.com' },
      ctx,
      bypassApproval: true,
    });
    expect(state.displayName).toBe('New Name');
    expect(state.email).toBe('new@example.com');
  });

  it('user.profile.update without any field fails validation', async () => {
    const { registry, audit } = await buildRegistry();
    const { db } = makeUserAwareDbStub({ id: USER_ID, email: 'a@b.com', displayName: 'A' });
    const ctx = makeCtx(audit, db);
    await expect(
      registry.dispatch({
        name: 'user.profile.update',
        input: {},
        ctx,
        bypassApproval: true,
      }),
    ).rejects.toBeInstanceOf(ToolInputValidationError);
  });
});

// ===========================================================================
// knowledge.*
// ===========================================================================

describe('knowledge tools', () => {
  it('knowledge.docs.create wirft ApprovalRequiredError', async () => {
    const { registry, audit } = await buildRegistry();
    const { db } = makeUserAwareDbStub({ id: USER_ID, email: 'a@b.com', displayName: 'A' });
    const ctx = makeCtx(audit, db);
    await expect(
      registry.dispatch({
        name: 'knowledge.docs.create',
        input: { title: 'T', body: 'B' },
        ctx,
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('knowledge.docs.create mit bypass → ruft createObject', async () => {
    const knowledge = new KnowledgeService({
      adapter: makeKnowledgeAdapterStub(),
      audit: makeAuditStub(),
    });
    const spy = vi.spyOn(knowledge, 'createObject');
    const { registry, audit } = await buildRegistry({ knowledge });
    const { db } = makeUserAwareDbStub({ id: USER_ID, email: 'a@b.com', displayName: 'A' });
    const ctx = makeCtx(audit, db);
    await registry.dispatch({
      name: 'knowledge.docs.create',
      input: { title: 'T', body: 'B', description: 'D' },
      ctx,
      bypassApproval: true,
    });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, subtype: 'doc', title: 'T', body: 'B', description: 'D' }),
    );
  });

  it('knowledge.docs.read forwards to getObject', async () => {
    const { registry, audit } = await buildRegistry();
    const { db } = makeUserAwareDbStub({ id: USER_ID, email: 'a@b.com', displayName: 'A' });
    const ctx = makeCtx(audit, db);
    const res = await registry.dispatch({
      name: 'knowledge.docs.read',
      input: { id: 'obj-1' },
      ctx,
    });
    expect((res.result.content[0] as { text: string }).text).toContain('"id":"obj-1"');
  });

  it('knowledge.docs.list returns docs', async () => {
    const { registry, audit } = await buildRegistry();
    const { db } = makeUserAwareDbStub({ id: USER_ID, email: 'a@b.com', displayName: 'A' });
    const ctx = makeCtx(audit, db);
    const res = await registry.dispatch({
      name: 'knowledge.docs.list',
      input: {},
      ctx,
    });
    expect((res.result.content[0] as { text: string }).text).toContain('"nextCursor":null');
  });

  it('knowledge.skills.list returns skills', async () => {
    const { registry, audit } = await buildRegistry();
    const { db } = makeUserAwareDbStub({ id: USER_ID, email: 'a@b.com', displayName: 'A' });
    const ctx = makeCtx(audit, db);
    const res = await registry.dispatch({
      name: 'knowledge.skills.list',
      input: {},
      ctx,
    });
    expect((res.result.content[0] as { text: string }).text).toContain('My Skill');
  });

  it('knowledge.search returns hits', async () => {
    const { registry, audit } = await buildRegistry();
    const { db } = makeUserAwareDbStub({ id: USER_ID, email: 'a@b.com', displayName: 'A' });
    const ctx = makeCtx(audit, db);
    const res = await registry.dispatch({
      name: 'knowledge.search',
      input: { query: 'test' },
      ctx,
    });
    const text = (res.result.content[0] as { text: string }).text;
    expect(text).toContain('"hits"');
    expect(text).toContain('"score":0.42');
  });

  it('knowledge.search: empty query → ToolInputValidationError', async () => {
    const { registry, audit } = await buildRegistry();
    const { db } = makeUserAwareDbStub({ id: USER_ID, email: 'a@b.com', displayName: 'A' });
    const ctx = makeCtx(audit, db);
    await expect(
      registry.dispatch({ name: 'knowledge.search', input: { query: '' }, ctx }),
    ).rejects.toBeInstanceOf(ToolInputValidationError);
  });
});

// ===========================================================================
// credentials.*
// ===========================================================================

describe('credentials tools', () => {
  it('credentials.list returns meta only (no secrets)', async () => {
    const { registry, audit } = await buildRegistry();
    const { db } = makeUserAwareDbStub({ id: USER_ID, email: 'a@b.com', displayName: 'A' });
    const ctx = makeCtx(audit, db);
    const res = await registry.dispatch({ name: 'credentials.list', input: {}, ctx });
    const text = (res.result.content[0] as { text: string }).text;
    expect(text).toContain('cred-1');
    expect(text).not.toContain('secret');
  });

  it('credentials.add without bypass → ApprovalRequiredError', async () => {
    const { registry, audit } = await buildRegistry();
    const { db } = makeUserAwareDbStub({ id: USER_ID, email: 'a@b.com', displayName: 'A' });
    const ctx = makeCtx(audit, db);
    await expect(
      registry.dispatch({
        name: 'credentials.add',
        input: {
          provider: 'github',
          kind: 'api_token',
          label: 'default',
          secret: 'ghp_xxx',
        },
        ctx,
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('credentials.add mit bypass aber ohne prfSessionId → PrfRequiredError', async () => {
    const { registry, audit } = await buildRegistry();
    const { db } = makeUserAwareDbStub({ id: USER_ID, email: 'a@b.com', displayName: 'A' });
    const ctx = makeCtx(audit, db);
    await expect(
      registry.dispatch({
        name: 'credentials.add',
        input: {
          provider: 'github',
          kind: 'api_token',
          label: 'default',
          secret: 'ghp_xxx',
        },
        ctx,
        bypassApproval: true,
      }),
    ).rejects.toBeInstanceOf(PrfRequiredError);
  });

  it('credentials.add mit prfSessionId + bypass → ruft create', async () => {
    const credentials = makeCredentialsStub();
    const createSpy = vi.spyOn(credentials, 'create');
    const prfSessions = new InMemoryPrfSessionService();
    const prfOutput = new Uint8Array(32);
    prfOutput[0] = 0x42;
    const sessionId = await prfSessions.store({ userId: USER_ID, prfOutput });

    const { registry, audit } = await buildRegistry({ credentials, prfSessions });
    const { db } = makeUserAwareDbStub({ id: USER_ID, email: 'a@b.com', displayName: 'A' });
    const ctx = makeCtx(audit, db);
    await registry.dispatch({
      name: 'credentials.add',
      input: {
        provider: 'github',
        kind: 'api_token',
        label: 'default',
        secret: 'ghp_xxx',
        prfSessionId: sessionId,
      },
      ctx,
      bypassApproval: true,
    });
    expect(createSpy).toHaveBeenCalledTimes(1);
    const call = createSpy.mock.calls[0]?.[0];
    expect(call?.userId).toBe(USER_ID);
    expect(call?.provider).toBe('github');
    expect(call?.prfOutput).toBeInstanceOf(Uint8Array);
    expect(call?.prfOutput?.[0]).toBe(0x42);
  });

  it('credentials.add mit prfEnabled=false skipt PRF', async () => {
    const credentials = makeCredentialsStub();
    const createSpy = vi.spyOn(credentials, 'create');
    const { registry, audit } = await buildRegistry({ credentials });
    const { db } = makeUserAwareDbStub({ id: USER_ID, email: 'a@b.com', displayName: 'A' });
    const ctx = makeCtx(audit, db);
    await registry.dispatch({
      name: 'credentials.add',
      input: {
        provider: 'github',
        kind: 'api_token',
        label: 'default',
        secret: 'ghp_xxx',
        prfEnabled: false,
      },
      ctx,
      bypassApproval: true,
    });
    const call = createSpy.mock.calls[0]?.[0];
    expect(call?.prfEnabled).toBe(false);
    expect(call?.prfOutput).toBeUndefined();
  });

  it('credentials.delete ist danger → ApprovalRequiredError ohne bypass', async () => {
    const { registry, audit } = await buildRegistry();
    const { db } = makeUserAwareDbStub({ id: USER_ID, email: 'a@b.com', displayName: 'A' });
    const ctx = makeCtx(audit, db);
    await expect(
      registry.dispatch({
        name: 'credentials.delete',
        input: { credentialId: 'cred-1' },
        ctx,
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('credentials.delete mit bypass ruft delete', async () => {
    const credentials = makeCredentialsStub();
    const deleteSpy = vi.spyOn(credentials, 'delete');
    const { registry, audit } = await buildRegistry({ credentials });
    const { db } = makeUserAwareDbStub({ id: USER_ID, email: 'a@b.com', displayName: 'A' });
    const ctx = makeCtx(audit, db);
    const res = await registry.dispatch({
      name: 'credentials.delete',
      input: { credentialId: 'cred-1' },
      ctx,
      bypassApproval: true,
    });
    expect(deleteSpy).toHaveBeenCalledWith({ userId: USER_ID, credentialId: 'cred-1' });
    expect((res.result.content[0] as { text: string }).text).toContain('"deleted":true');
  });
});
