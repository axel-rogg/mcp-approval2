/**
 * Apps-HTTP-Routes.
 *
 *   POST   /v1/apps                 — create
 *   GET    /v1/apps                 — list
 *   GET    /v1/apps/:id             — read (state + layout)
 *   PATCH  /v1/apps/:id/state       — update_state (CAS via expectedVersion)
 *   DELETE /v1/apps/:id             — delete
 *   POST   /v1/apps/:id/invoke      — invoke block action
 *   POST   /v1/apps/:id/query       — query (read-only)
 *   PATCH  /v1/apps/:id/layout      — update_layout
 *
 *   GET    /apps/standalone/:appId/ — PWA-iframe-bridge (signed JWT)
 *
 * Auth: Bearer-Session-JWT pro Route. Auth-Middleware setzt `c.var.user`.
 * Standalone-bridge issued ein 15min-AppJWT (HS256) das die iframe-Surface
 * fuer Block-Dispatch nutzen kann.
 *
 * Multi-User: jeder Call uebergibt principal.userId an den AppsService.
 */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppBindings, ServerContext } from '../lib/context.js';
import { HttpError } from '../lib/errors.js';
import { auth } from '../middleware/auth.js';
import { AppsServiceError, type AppsService } from '../apps/api.js';
import { ActionRoutingError } from '../apps/action_router.js';
import { signAppJwt } from '../apps/jwt.js';
import type { LayoutDoc } from '../apps/blocks/types.js';

export interface AppsRouteDeps {
  readonly server: ServerContext;
  readonly apps: AppsService;
  /**
   * Master-Key fuer App-JWT-Signing. Wenn nicht gesetzt, wird /apps/standalone
   * NICHT gemounted (Standalone-Surface deaktiviert).
   */
  readonly masterKey?: string;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const createSchema = z.object({
  appType: z.string().min(1).max(64),
  slug: z.string().min(1).max(64).optional(),
  title: z.string().min(1).max(200).optional(),
  initialState: z.unknown().optional(),
  summary: z.string().min(1).max(500).optional(),
});

const listQuerySchema = z.object({
  type: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const updateStateSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  newState: z.unknown(),
});

const invokeSchema = z.object({
  block_id: z.string().min(1).max(64),
  action: z.string().min(1).max(128),
  payload: z.record(z.unknown()).optional(),
});

const querySchema = z.object({
  block_id: z.string().min(1).max(64),
  query: z.string().min(1).max(128),
  args: z.record(z.unknown()).optional(),
});

const updateLayoutSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  layoutDoc: z.unknown(),
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function mapAppsError(err: AppsServiceError): never {
  switch (err.code) {
    case 'NOT_FOUND':
      throw HttpError.notFound(err.message, { code: err.code });
    case 'UNKNOWN_TYPE':
    case 'INVALID_STATE':
    case 'INVALID_LAYOUT':
    case 'INVALID_ACTION':
      throw HttpError.badRequest('invalid_request', err.message, { code: err.code });
    case 'SINGLE_INSTANCE':
      throw HttpError.conflict(err.message, { code: err.code });
    case 'CONCURRENT_UPDATE':
      throw HttpError.conflict(err.message, { code: err.code });
    case 'INTERNAL':
    default:
      throw new HttpError(500, 'internal', err.message);
  }
}

function mapRoutingError(err: ActionRoutingError): never {
  throw HttpError.badRequest('invalid_request', err.message, { code: err.code });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function appsRoutes(deps: AppsRouteDeps): Hono<AppBindings> {
  const { server, apps, masterKey } = deps;
  const app = new Hono<AppBindings>();
  const guard = auth(server);

  // POST /v1/apps — create
  app.post('/v1/apps', guard, zValidator('json', createSchema), async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const body = c.req.valid('json');
    try {
      const args: Parameters<AppsService['createApp']>[0] = {
        userId: principal.userId,
        appType: body.appType,
      };
      if (body.slug !== undefined) (args as { slug?: string }).slug = body.slug;
      if (body.title !== undefined) (args as { title?: string }).title = body.title;
      if (body.initialState !== undefined) (args as { initialState?: unknown }).initialState = body.initialState;
      if (body.summary !== undefined) (args as { summary?: string }).summary = body.summary;
      const inst = await apps.createApp(args);
      return c.json({ app: inst }, 201);
    } catch (e) {
      if (e instanceof AppsServiceError) mapAppsError(e);
      throw e;
    }
  });

  // GET /v1/apps — list
  app.get('/v1/apps', guard, zValidator('query', listQuerySchema), async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const q = c.req.valid('query');
    const args: Parameters<AppsService['listApps']>[0] = {
      userId: principal.userId,
      userEmail: principal.email,
    };
    if (q.type !== undefined) (args as { type?: string }).type = q.type;
    if (q.limit !== undefined) (args as { limit?: number }).limit = q.limit;
    const items = await apps.listApps(args);
    return c.json({ items, count: items.length });
  });

  // GET /v1/apps/:id — read
  app.get('/v1/apps/:id', guard, async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const id = c.req.param('id');
    try {
      const read = await apps.readApp({
        userId: principal.userId,
        userEmail: principal.email,
        id,
      });
      return c.json({ app: read.app, state: read.state });
    } catch (e) {
      if (e instanceof AppsServiceError) mapAppsError(e);
      throw e;
    }
  });

  // PATCH /v1/apps/:id/state — update_state
  app.patch('/v1/apps/:id/state', guard, zValidator('json', updateStateSchema), async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const id = c.req.param('id');
    const body = c.req.valid('json');
    try {
      const inst = await apps.updateState({
        userId: principal.userId,
        userEmail: principal.email,
        approvalId: randomUUID(),
        id,
        statePatch: body.newState,
        expectedVersion: body.expectedVersion,
      });
      return c.json({ app: inst, new_version: inst.state_version });
    } catch (e) {
      if (e instanceof AppsServiceError) mapAppsError(e);
      throw e;
    }
  });

  // DELETE /v1/apps/:id — delete
  app.delete('/v1/apps/:id', guard, async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const id = c.req.param('id');
    try {
      await apps.deleteApp({
        userId: principal.userId,
        userEmail: principal.email,
        approvalId: randomUUID(),
        id,
      });
      return c.json({ ok: true, deleted: id });
    } catch (e) {
      if (e instanceof AppsServiceError) mapAppsError(e);
      throw e;
    }
  });

  // POST /v1/apps/:id/invoke — block action
  // K-D4-Notiz: invoke schreibt state-version+1 nach KC2. PWA-direkte Calls
  // (iframe_auto_approve=true Block-Actions) haben keinen User-Approval —
  // wir generieren synthetic approval_id pro Request. Audit-Log haelt fest,
  // dass es PWA-direkt war (kein User-Sign-Off).
  app.post('/v1/apps/:id/invoke', guard, zValidator('json', invokeSchema), async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const id = c.req.param('id');
    const body = c.req.valid('json');
    try {
      const r = await apps.invoke({
        userId: principal.userId,
        userEmail: principal.email,
        approvalId: randomUUID(),
        id,
        block_id: body.block_id,
        action: body.action,
        payload: body.payload ?? {},
      });
      return c.json({
        app: r.app,
        new_version: r.new_version,
        result: r.result,
        patches: r.patches,
      });
    } catch (e) {
      if (e instanceof ActionRoutingError) mapRoutingError(e);
      if (e instanceof AppsServiceError) mapAppsError(e);
      throw e;
    }
  });

  // POST /v1/apps/:id/query — block query (read-only, kein approval_id)
  app.post('/v1/apps/:id/query', guard, zValidator('json', querySchema), async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const id = c.req.param('id');
    const body = c.req.valid('json');
    try {
      const value = await apps.query({
        userId: principal.userId,
        userEmail: principal.email,
        id,
        block_id: body.block_id,
        query: body.query,
        ...(body.args !== undefined ? { args: body.args } : {}),
      });
      return c.json({ value });
    } catch (e) {
      if (e instanceof ActionRoutingError) mapRoutingError(e);
      if (e instanceof AppsServiceError) mapAppsError(e);
      throw e;
    }
  });

  // PATCH /v1/apps/:id/layout — update_layout (full LayoutDoc replace)
  app.patch('/v1/apps/:id/layout', guard, zValidator('json', updateLayoutSchema), async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const id = c.req.param('id');
    const body = c.req.valid('json');
    try {
      const inst = await apps.updateLayout({
        userId: principal.userId,
        userEmail: principal.email,
        approvalId: randomUUID(),
        id,
        layoutDoc: body.layoutDoc as LayoutDoc,
        expectedVersion: body.expectedVersion,
      });
      return c.json({ app: inst, new_version: inst.state_version });
    } catch (e) {
      if (e instanceof AppsServiceError) mapAppsError(e);
      throw e;
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // PWA-Standalone-Bridge
  //   GET /apps/standalone/:appId
  //
  // PWA-authed: ruft mit Session-Cookie/Bearer auf, bekommt eine signierte
  // AppJWT zurueck mit sub=userId + aid=appId. iframe nutzt das fuer
  // direktes Dispatch ohne erneuten WebAuthn-Roundtrip.
  // ─────────────────────────────────────────────────────────────────
  if (masterKey) {
    app.get('/apps/standalone/:appId', guard, async (c) => {
      const principal = c.get('user');
      if (!principal) throw HttpError.unauthorized();
      const appId = c.req.param('appId');
      // Verify app exists + belongs to user.
      try {
        await apps.readApp({ userId: principal.userId, id: appId });
      } catch (e) {
        if (e instanceof AppsServiceError) mapAppsError(e);
        throw e;
      }
      const issued = await signAppJwt({
        userId: principal.userId,
        appId,
        masterKey,
        issuer: 'mcp-approval2',
        audience: 'mcp-approval2-apps',
      });
      return c.json({
        token: issued.token,
        expires_at: issued.expires_at,
        app_id: appId,
      });
    });
  }

  return app;
}
