/**
 * Admin-Routes — only role='admin' allowed.
 *
 * Plan-Ref: PLAN-architecture-v1.md §4.1.
 */

import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { AppBindings } from '../lib/context.js';
import { HttpError } from '../lib/errors.js';
import type { AdminService } from '../services/admin.js';

export function adminOnly(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) throw new HttpError(401, 'unauthorized', 'authentication required');
    if (user.role !== 'admin') throw new HttpError(403, 'forbidden', 'admin role required');
    await next();
  };
}

export interface AdminRouteDeps {
  admin: AdminService;
}

export function adminRoutes(deps: AdminRouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use('*', adminOnly());

  app.get('/users', async (c) => {
    const limit = Number(c.req.query('limit') ?? 50);
    const offset = Number(c.req.query('offset') ?? 0);
    const status = c.req.query('status') as 'active' | 'invited' | 'suspended' | 'deleted' | undefined;
    const users = await deps.admin.listUsers({ limit, offset, ...(status ? { status } : {}) });
    return c.json({ users });
  });

  app.get('/users/:id', async (c) => {
    const id = c.req.param('id');
    const user = await deps.admin.getUser({ id });
    if (!user) throw new HttpError(404, 'not_found', 'user not found');
    return c.json({ user });
  });

  app.post(
    '/users/:id/suspend',
    zValidator('json', z.object({ reason: z.string().max(1000).optional() }).optional()),
    async (c) => {
      const id = c.req.param('id');
      const actor = c.get('user');
      if (!actor) throw new HttpError(401, 'unauthorized', 'authentication required');
      const body = c.req.valid('json') ?? {};
      const suspendArgs: { id: string; actorUserId: string; reason?: string } = {
        id,
        actorUserId: actor.userId,
      };
      if (body.reason !== undefined) suspendArgs.reason = body.reason;
      await deps.admin.suspendUser(suspendArgs);
      return c.json({ status: 'suspended' });
    },
  );

  app.post('/users/:id/unsuspend', async (c) => {
    const id = c.req.param('id');
    const actor = c.get('user');
    if (!actor) throw new HttpError(401, 'unauthorized', 'authentication required');
    await deps.admin.unsuspendUser({ id, actorUserId: actor.userId });
    return c.json({ status: 'active' });
  });

  app.get('/users/:id/audit', async (c) => {
    const userId = c.req.param('id');
    const limit = Number(c.req.query('limit') ?? 100);
    const offset = Number(c.req.query('offset') ?? 0);
    const entries = await deps.admin.listAuditForUser({ userId, limit, offset });
    return c.json({ entries });
  });

  app.get('/audit', async (c) => {
    const limit = Number(c.req.query('limit') ?? 100);
    const offset = Number(c.req.query('offset') ?? 0);
    const action = c.req.query('action');
    const entries = await deps.admin.listSystemAudit({
      limit,
      offset,
      ...(action ? { action } : {}),
    });
    return c.json({ entries });
  });

  return app;
}
