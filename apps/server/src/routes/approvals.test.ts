/**
 * Integration-Tests fuer /v1/approvals/*-Routes.
 *
 * Wir bauen die Routes standalone (ohne app-factory) mit:
 *   - echtem Hono + auth-Middleware
 *   - echt-issued Session-JWT via `issueSessionJwt`
 *   - in-memory ApprovalService-Mock (Map-based)
 *   - ToolRegistry mit einem write-Tool, sodass `resumeApproval` durchlaeuft
 *
 * Coverage:
 *   - GET /v1/approvals (list, status-filter)
 *   - GET /v1/approvals/:id (own/not-own)
 *   - POST /:id/approve (happy + 409 already-approved + 403 wrong-user)
 *   - POST /:id/reject
 *   - GET /:id/result (202 wenn pending, 200 wenn ready)
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings, ServerContext } from '../lib/context.js';
import type { AppConfig } from '../lib/config.js';
import { HttpError } from '../lib/errors.js';
import type { DbAdapter, ScopedDb, RawDb, TransactionCtx } from '@mcp-approval2/adapters';
import { issueSessionJwt } from '../auth/session/issuer.js';
import { randomUuidV4 } from '@mcp-approval2/core';
import { requestId } from '../middleware/request-id.js';
import { errorHandler } from '../middleware/error-handler.js';
import { approvalsRoutes } from './approvals.js';
import {
  ApprovalConflictError,
  type ApprovalService,
  type CreateApprovalArgs,
  type GetApprovalArgs,
  type ListApprovalsArgs,
  type ApproveArgs,
  type RejectArgs,
  type SetResultArgs,
} from '../services/approvals.js';
import { ToolRegistry } from '../mcp/protocol/registry.js';
import type { AuditService, Tool, ToolResultContent } from '../mcp/protocol/tool.js';
import type {
  ApprovalStatus,
  PendingApproval,
} from '../schema/types.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makeStubDb(): DbAdapter {
  const scoped: ScopedDb = {
    userId: 'test',
    dialect: 'postgres',
    drizzle: {},
    async query<T>(): Promise<T[]> {
      return [];
    },
  };
  const raw: RawDb = {
    dialect: 'postgres',
    drizzle: {},
    async query<T>(): Promise<T[]> {
      return [];
    },
  };
  return {
    dialect: 'postgres',
    async scoped() {
      return scoped;
    },
    unsafe() {
      return raw;
    },
    async transaction<T>(_uid: string, fn: (tx: ScopedDb, ctx: TransactionCtx) => Promise<T>) {
      return fn(scoped, { userId: 'test', dialect: 'postgres' });
    },
    async migrate() {},
    async close() {},
  };
}

function makeConfig(): AppConfig {
  return {
    NODE_ENV: 'test',
    PORT: 0,
    ORIGIN: 'http://localhost:8787',
    DATABASE_URL: 'postgres://stub',
    DATABASE_DIALECT: 'postgres',
    JWT_SECRET: 'x'.repeat(32),
    JWT_ISSUER: 'mcp-approval2',
    JWT_AUDIENCE: 'mcp-approval2-api',
    SESSION_TTL_SEC: 1800,
    REFRESH_TTL_SEC: 30 * 24 * 60 * 60,
    GOOGLE_CLIENT_ID: 'stub',
    GOOGLE_CLIENT_SECRET: 'stub',
    GOOGLE_REDIRECT_URI: 'http://localhost:8787/auth/google/callback',
    RP_ID: 'localhost',
    RP_NAME: 'mcp-approval2',
    RP_ORIGIN: 'http://localhost:8787',
    INVITE_TTL_SEC: 24 * 60 * 60,
    RECOVERY_TTL_SEC: 24 * 60 * 60,
    ALLOWED_ORIGINS: [],
    COOKIE_DOMAIN: '',
    GOOGLE_ALLOWED_AUDIENCES: [],
    DCR_OPEN: true,
    DCR_ALLOWED_REDIRECT_HOSTS: [],
  };
}

interface MockState {
  rows: Map<string, PendingApproval>;
}

function makeMockApprovals(state: MockState): ApprovalService {
  const fresh = (init: PendingApproval): PendingApproval => init;

  return {
    async create(args: CreateApprovalArgs): Promise<PendingApproval> {
      const id = randomUuidV4();
      const createdAt = Date.now();
      const expiresAt = createdAt + (args.ttlSec ?? 300) * 1000;
      const row = fresh({
        id,
        userId: args.userId,
        toolName: args.toolName,
        toolInput: args.toolInput,
        displayTemplate: args.displayTemplate ?? null,
        displayRendered: args.displayTemplate ?? null,
        sensitivity: args.sensitivity,
        status: 'pending',
        approvalChallenge: 'stub-challenge',
        approvalSignature: null,
        approvedAt: null,
        rejectedAt: null,
        rejectionReason: null,
        expiredAt: null,
        prfSessionId: null,
        resultJson: null,
        resultEmittedAt: null,
        requestId: args.requestId ?? null,
        originIp: args.ip ?? null,
        createdAt,
        expiresAt,
      });
      state.rows.set(id, row);
      return row;
    },
    async get(args: GetApprovalArgs): Promise<PendingApproval | null> {
      const r = state.rows.get(args.id);
      if (!r || r.userId !== args.userId) return null;
      return r;
    },
    async list(args: ListApprovalsArgs): Promise<PendingApproval[]> {
      return Array.from(state.rows.values())
        .filter((r) => r.userId === args.userId)
        .filter((r) => !args.status || r.status === args.status)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, args.limit ?? 50);
    },
    async approve(args: ApproveArgs): Promise<PendingApproval> {
      const r = state.rows.get(args.id);
      if (!r || r.userId !== args.userId) {
        throw new HttpError(404, 'not_found', 'approval not found');
      }
      if (r.status !== 'pending') {
        throw new ApprovalConflictError(args.id, r.status as ApprovalStatus);
      }
      const updated: PendingApproval = {
        ...r,
        status: 'approved',
        approvalSignature: args.signature,
        approvedAt: Date.now(),
        prfSessionId: args.prfSessionId ?? null,
      };
      state.rows.set(args.id, updated);
      return updated;
    },
    async reject(args: RejectArgs): Promise<PendingApproval> {
      const r = state.rows.get(args.id);
      if (!r || r.userId !== args.userId) {
        throw new HttpError(404, 'not_found', 'approval not found');
      }
      if (r.status !== 'pending') {
        throw new ApprovalConflictError(args.id, r.status as ApprovalStatus);
      }
      const updated: PendingApproval = {
        ...r,
        status: 'rejected',
        rejectedAt: Date.now(),
        rejectionReason: args.reason ?? null,
      };
      state.rows.set(args.id, updated);
      return updated;
    },
    async sweepExpired(): Promise<number> {
      let n = 0;
      const now = Date.now();
      for (const [k, r] of state.rows) {
        if (r.status === 'pending' && r.expiresAt < now) {
          state.rows.set(k, { ...r, status: 'expired', expiredAt: now });
          n++;
        }
      }
      return n;
    },
    async setResult(args: SetResultArgs): Promise<void> {
      const r = state.rows.get(args.id);
      if (r) {
        state.rows.set(args.id, {
          ...r,
          resultJson: args.result,
          resultEmittedAt: Date.now(),
        });
      }
    },
  };
}

function makeRegistryWithWriteTool(): ToolRegistry {
  const r = new ToolRegistry();
  const writeTool: Tool<{ title: string }, ToolResultContent[]> = {
    name: 'docs.put',
    description: 'Stub write tool',
    inputSchema: z.object({ title: z.string().min(1) }),
    sensitivity: 'write',
    displayTemplate: 'Put doc {{title}}',
    async execute(_ctx, input) {
      return [{ type: 'text', text: `wrote ${input.title}` }];
    },
  };
  r.register(writeTool);
  return r;
}

const auditNoop: AuditService = {
  async emit() {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeBearer(userId: string, config: AppConfig): Promise<string> {
  const { token } = await issueSessionJwt(
    {
      userId,
      email: 'tester@example.com',
      role: 'member',
      sessionId: randomUuidV4(),
    },
    config,
  );
  return `Bearer ${token}`;
}

function buildApp(deps: {
  server: ServerContext;
  approvals: ApprovalService;
  registry: ToolRegistry;
  audit: AuditService;
  verifyAssertion?: (args: unknown) => Promise<void>;
}): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use('*', requestId());
  app.onError(errorHandler());
  const routeDeps = {
    server: deps.server,
    approvals: deps.approvals,
    registry: deps.registry,
    audit: deps.audit,
    ...(deps.verifyAssertion
      ? { verifyAssertion: deps.verifyAssertion as never }
      : {}),
  };
  app.route('/', approvalsRoutes(routeDeps));
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('approvals routes', () => {
  it('GET /v1/approvals without bearer → 401', async () => {
    const config = makeConfig();
    const state: MockState = { rows: new Map() };
    const app = buildApp({
      server: { config, db: makeStubDb() },
      approvals: makeMockApprovals(state),
      registry: makeRegistryWithWriteTool(),
      audit: auditNoop,
    });
    const res = await app.request('/v1/approvals');
    expect(res.status).toBe(401);
  });

  it('GET /v1/approvals returns own pending list', async () => {
    const config = makeConfig();
    const state: MockState = { rows: new Map() };
    const userId = randomUuidV4();
    const approvalsSvc = makeMockApprovals(state);
    await approvalsSvc.create({
      userId,
      toolName: 'docs.put',
      toolInput: { title: 'A' },
      sensitivity: 'write',
    });
    const app = buildApp({
      server: { config, db: makeStubDb() },
      approvals: approvalsSvc,
      registry: makeRegistryWithWriteTool(),
      audit: auditNoop,
    });
    const auth = await makeBearer(userId, config);
    const res = await app.request('/v1/approvals', { headers: { authorization: auth } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approvals: Array<{ status: string }> };
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]?.status).toBe('pending');
  });

  it('GET /v1/approvals filters by status', async () => {
    const config = makeConfig();
    const state: MockState = { rows: new Map() };
    const userId = randomUuidV4();
    const approvalsSvc = makeMockApprovals(state);
    const a = await approvalsSvc.create({
      userId,
      toolName: 'docs.put',
      toolInput: { title: 'A' },
      sensitivity: 'write',
    });
    await approvalsSvc.create({
      userId,
      toolName: 'docs.put',
      toolInput: { title: 'B' },
      sensitivity: 'write',
    });
    await approvalsSvc.reject({ id: a.id, userId });
    const app = buildApp({
      server: { config, db: makeStubDb() },
      approvals: approvalsSvc,
      registry: makeRegistryWithWriteTool(),
      audit: auditNoop,
    });
    const auth = await makeBearer(userId, config);
    const res = await app.request('/v1/approvals?status=rejected', {
      headers: { authorization: auth },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approvals: Array<{ status: string; id: string }> };
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]?.id).toBe(a.id);
  });

  it('GET /v1/approvals/:id own → 200', async () => {
    const config = makeConfig();
    const state: MockState = { rows: new Map() };
    const userId = randomUuidV4();
    const approvalsSvc = makeMockApprovals(state);
    const a = await approvalsSvc.create({
      userId,
      toolName: 'docs.put',
      toolInput: { title: 'A' },
      sensitivity: 'write',
    });
    const app = buildApp({
      server: { config, db: makeStubDb() },
      approvals: approvalsSvc,
      registry: makeRegistryWithWriteTool(),
      audit: auditNoop,
    });
    const auth = await makeBearer(userId, config);
    const res = await app.request(`/v1/approvals/${a.id}`, { headers: { authorization: auth } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approval: { id: string } };
    expect(body.approval.id).toBe(a.id);
  });

  it('GET /v1/approvals/:id from wrong user → 404', async () => {
    const config = makeConfig();
    const state: MockState = { rows: new Map() };
    const userA = randomUuidV4();
    const userB = randomUuidV4();
    const approvalsSvc = makeMockApprovals(state);
    const a = await approvalsSvc.create({
      userId: userA,
      toolName: 'docs.put',
      toolInput: { title: 'A' },
      sensitivity: 'write',
    });
    const app = buildApp({
      server: { config, db: makeStubDb() },
      approvals: approvalsSvc,
      registry: makeRegistryWithWriteTool(),
      audit: auditNoop,
    });
    const auth = await makeBearer(userB, config);
    const res = await app.request(`/v1/approvals/${a.id}`, { headers: { authorization: auth } });
    expect(res.status).toBe(404);
  });

  it('POST /v1/approvals/:id/approve happy-path triggers re-dispatch', async () => {
    const config = makeConfig();
    const state: MockState = { rows: new Map() };
    const userId = randomUuidV4();
    const approvalsSvc = makeMockApprovals(state);
    const a = await approvalsSvc.create({
      userId,
      toolName: 'docs.put',
      toolInput: { title: 'A' },
      sensitivity: 'write',
    });
    const app = buildApp({
      server: { config, db: makeStubDb() },
      approvals: approvalsSvc,
      registry: makeRegistryWithWriteTool(),
      audit: auditNoop,
    });
    const auth = await makeBearer(userId, config);
    const res = await app.request(`/v1/approvals/${a.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({
        credentialIdB64: btoa('cred'),
        authenticatorDataB64: btoa('authData'),
        clientDataJsonB64: btoa('{"type":"webauthn.get"}'),
        signatureB64: btoa('sig'),
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      approval: { status: string; resultEmittedAt: number | null };
      resume_error: string | null;
    };
    expect(body.approval.status).toBe('approved');
    expect(body.resume_error).toBeNull();
    expect(body.approval.resultEmittedAt).not.toBeNull();
  });

  // SEC-001: ohne gueltige WebAuthn-Assertion bleibt die Approval auf 'pending'.
  it('POST /v1/approvals/:id/approve with failing verifier → 401 + status unchanged', async () => {
    const config = makeConfig();
    const state: MockState = { rows: new Map() };
    const userId = randomUuidV4();
    const approvalsSvc = makeMockApprovals(state);
    const a = await approvalsSvc.create({
      userId,
      toolName: 'docs.put',
      toolInput: { title: 'A' },
      sensitivity: 'write',
    });
    const app = buildApp({
      server: { config, db: makeStubDb() },
      approvals: approvalsSvc,
      registry: makeRegistryWithWriteTool(),
      audit: auditNoop,
      verifyAssertion: async () => {
        throw HttpError.unauthorized('webauthn_verification_failed');
      },
    });
    const auth = await makeBearer(userId, config);
    const res = await app.request(`/v1/approvals/${a.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({
        credentialIdB64: btoa('cred'),
        authenticatorDataB64: btoa('authData'),
        clientDataJsonB64: btoa('{"type":"webauthn.get"}'),
        signatureB64: btoa('sig'),
      }),
    });
    expect(res.status).toBe(401);
    // Approval MUSS auf 'pending' bleiben.
    const after = await approvalsSvc.get({ id: a.id, userId });
    expect(after?.status).toBe('pending');
    expect(after?.approvalSignature).toBeNull();
  });

  // SEC-001: Schema-Validation lehnt Approvals ohne credentialId/etc ab.
  it('POST /v1/approvals/:id/approve without assertion fields → 400', async () => {
    const config = makeConfig();
    const state: MockState = { rows: new Map() };
    const userId = randomUuidV4();
    const approvalsSvc = makeMockApprovals(state);
    const a = await approvalsSvc.create({
      userId,
      toolName: 'docs.put',
      toolInput: { title: 'A' },
      sensitivity: 'write',
    });
    const app = buildApp({
      server: { config, db: makeStubDb() },
      approvals: approvalsSvc,
      registry: makeRegistryWithWriteTool(),
      audit: auditNoop,
    });
    const auth = await makeBearer(userId, config);
    const res = await app.request(`/v1/approvals/${a.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({ signatureB64: btoa('sig') }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /v1/approvals/:id/approve from wrong-user → 404 (RLS-like)', async () => {
    const config = makeConfig();
    const state: MockState = { rows: new Map() };
    const userA = randomUuidV4();
    const userB = randomUuidV4();
    const approvalsSvc = makeMockApprovals(state);
    const a = await approvalsSvc.create({
      userId: userA,
      toolName: 'docs.put',
      toolInput: { title: 'A' },
      sensitivity: 'write',
    });
    const app = buildApp({
      server: { config, db: makeStubDb() },
      approvals: approvalsSvc,
      registry: makeRegistryWithWriteTool(),
      audit: auditNoop,
    });
    const auth = await makeBearer(userB, config);
    const res = await app.request(`/v1/approvals/${a.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({
        credentialIdB64: btoa('cred'),
        authenticatorDataB64: btoa('authData'),
        clientDataJsonB64: btoa('{"type":"webauthn.get"}'),
        signatureB64: btoa('sig'),
      }),
    });
    expect(res.status).toBe(404);
  });

  it('POST /v1/approvals/:id/approve on already-approved → 409', async () => {
    const config = makeConfig();
    const state: MockState = { rows: new Map() };
    const userId = randomUuidV4();
    const approvalsSvc = makeMockApprovals(state);
    const a = await approvalsSvc.create({
      userId,
      toolName: 'docs.put',
      toolInput: { title: 'A' },
      sensitivity: 'write',
    });
    const app = buildApp({
      server: { config, db: makeStubDb() },
      approvals: approvalsSvc,
      registry: makeRegistryWithWriteTool(),
      audit: auditNoop,
    });
    const auth = await makeBearer(userId, config);
    // 1st: ok
    await app.request(`/v1/approvals/${a.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({
        credentialIdB64: btoa('cred'),
        authenticatorDataB64: btoa('authData'),
        clientDataJsonB64: btoa('{"type":"webauthn.get"}'),
        signatureB64: btoa('sig'),
      }),
    });
    // 2nd: 409
    const res2 = await app.request(`/v1/approvals/${a.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({
        credentialIdB64: btoa('cred'),
        authenticatorDataB64: btoa('authData'),
        clientDataJsonB64: btoa('{"type":"webauthn.get"}'),
        signatureB64: btoa('sig2'),
      }),
    });
    expect(res2.status).toBe(409);
    const body = (await res2.json()) as { error: { code: string } };
    expect(body.error.code).toBe('conflict');
  });

  it('POST /v1/approvals/:id/reject', async () => {
    const config = makeConfig();
    const state: MockState = { rows: new Map() };
    const userId = randomUuidV4();
    const approvalsSvc = makeMockApprovals(state);
    const a = await approvalsSvc.create({
      userId,
      toolName: 'docs.put',
      toolInput: { title: 'A' },
      sensitivity: 'write',
    });
    const app = buildApp({
      server: { config, db: makeStubDb() },
      approvals: approvalsSvc,
      registry: makeRegistryWithWriteTool(),
      audit: auditNoop,
    });
    const auth = await makeBearer(userId, config);
    const res = await app.request(`/v1/approvals/${a.id}/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({ reason: 'looks wrong' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approval: { status: string; rejectionReason: string } };
    expect(body.approval.status).toBe('rejected');
    expect(body.approval.rejectionReason).toBe('looks wrong');
  });

  it('GET /v1/approvals/:id/result returns 202 when pending, 200 when emitted', async () => {
    const config = makeConfig();
    const state: MockState = { rows: new Map() };
    const userId = randomUuidV4();
    const approvalsSvc = makeMockApprovals(state);
    const a = await approvalsSvc.create({
      userId,
      toolName: 'docs.put',
      toolInput: { title: 'A' },
      sensitivity: 'write',
    });
    const app = buildApp({
      server: { config, db: makeStubDb() },
      approvals: approvalsSvc,
      registry: makeRegistryWithWriteTool(),
      audit: auditNoop,
    });
    const auth = await makeBearer(userId, config);
    // Pending → 202
    const r1 = await app.request(`/v1/approvals/${a.id}/result`, {
      headers: { authorization: auth },
    });
    expect(r1.status).toBe(202);

    // Approve → result populated
    await app.request(`/v1/approvals/${a.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({
        credentialIdB64: btoa('cred'),
        authenticatorDataB64: btoa('authData'),
        clientDataJsonB64: btoa('{"type":"webauthn.get"}'),
        signatureB64: btoa('sig'),
      }),
    });
    const r2 = await app.request(`/v1/approvals/${a.id}/result`, {
      headers: { authorization: auth },
    });
    expect(r2.status).toBe(200);
    const body = (await r2.json()) as {
      status: string;
      result: { ok: boolean; content?: unknown };
    };
    expect(body.status).toBe('approved');
    expect(body.result.ok).toBe(true);
  });
});
