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
import type { EmailOutboxService } from '../services/email-outbox.js';

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
  emailOutbox?: EmailOutboxService;
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

  // ─── Multi-User Tier 1 (2026-05-17) ────────────────────────────────────

  app.post(
    '/users/:id/role',
    zValidator('json', z.object({ role: z.enum(['admin', 'member']) })),
    async (c) => {
      const id = c.req.param('id');
      const actor = c.get('user');
      if (!actor) throw new HttpError(401, 'unauthorized', 'authentication required');
      const { role } = c.req.valid('json');
      try {
        await deps.admin.changeRole({ id, newRole: role, actorUserId: actor.userId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('one_active_admin')) {
          throw new HttpError(409, 'conflict', msg);
        }
        throw err;
      }
      return c.json({ id, role });
    },
  );

  app.delete('/users/:id', async (c) => {
    const id = c.req.param('id');
    const actor = c.get('user');
    if (!actor) throw new HttpError(401, 'unauthorized', 'authentication required');
    try {
      await deps.admin.softDeleteUser({ id, actorUserId: actor.userId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('self-delete')) throw new HttpError(403, 'forbidden', msg);
      throw err;
    }
    return c.json({ status: 'deleted' });
  });

  // Email-Outbox — siehe services/email-outbox.ts. Bei EMAIL_PROVIDER=console
  // landen Mails hier statt zugestellt zu werden — Admin muss sie via UI
  // ansehen + manuell zustellen (Signal/iMessage/Email-Client).
  app.get('/email-outbox', async (c) => {
    if (!deps.emailOutbox) {
      throw new HttpError(503, 'not_found', 'email outbox service not configured');
    }
    const actor = c.get('user');
    if (!actor) throw new HttpError(401, 'unauthorized', 'authentication required');
    const kind = c.req.query('kind') as 'invite' | 'recovery' | 'notification' | undefined;
    const status = c.req.query('status') as 'sent' | 'failed' | 'logged' | undefined;
    const limit = Number(c.req.query('limit') ?? 100);
    const rows = await deps.emailOutbox.listOutbox({
      principalRole: actor.role,
      ...(kind ? { kind } : {}),
      ...(status ? { status } : {}),
      limit,
    });
    return c.json({ outbox: rows });
  });

  app.post('/email-outbox/:id/dispatched', async (c) => {
    if (!deps.emailOutbox) {
      throw new HttpError(503, 'not_found', 'email outbox service not configured');
    }
    const actor = c.get('user');
    if (!actor) throw new HttpError(401, 'unauthorized', 'authentication required');
    const outboxId = c.req.param('id');
    await deps.emailOutbox.markDispatched({ principalRole: actor.role, outboxId });
    return c.json({ status: 'dispatched' });
  });

  app.post('/email-outbox/:id/resend', async (c) => {
    if (!deps.emailOutbox) {
      throw new HttpError(503, 'not_found', 'email outbox service not configured');
    }
    const actor = c.get('user');
    if (!actor) throw new HttpError(401, 'unauthorized', 'authentication required');
    const outboxId = c.req.param('id');
    const result = await deps.emailOutbox.resend({ principalRole: actor.role, outboxId });
    return c.json(result);
  });

  return app;
}
