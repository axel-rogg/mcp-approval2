/**
 * Invite-Routen.
 *
 *   POST /admin/invites          — admin-only
 *   GET  /accept-invite/:token   — Redirect zu Google-Login mit Invite-Hint
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import { HttpError } from '../../lib/errors.js';
import { requireAdmin } from '../../middleware/auth.js';
import { createInvite } from '../../auth/invite/create.js';

const createInviteSchema = z.object({
  email: z.string().email(),
});

export function inviteRoutes(server: ServerContext): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.post(
    '/admin/invites',
    requireAdmin(server),
    zValidator('json', createInviteSchema),
    async (c) => {
      const principal = c.get('user');
      if (!principal) throw HttpError.unauthorized();
      const body = c.req.valid('json');
      const result = await createInvite(server.db, server.config, {
        email: body.email,
        invitedBy: principal.userId,
      });
      return c.json({
        inviteId: result.inviteId,
        acceptUrl: result.acceptUrl,
        expiresAt: result.expiresAt,
      }, 201);
    },
  );

  app.get('/accept-invite/:token', async (c) => {
    const token = c.req.param('token');
    if (!token) throw HttpError.badRequest('invalid_request', 'missing invite token');
    // Redirect zu Google-OAuth-Start mit Invite-Token als Query-Param
    const startUrl = new URL('/auth/google/start', server.config.ORIGIN);
    startUrl.searchParams.set('invite', token);
    return c.redirect(startUrl.toString());
  });

  return app;
}
