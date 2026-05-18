/**
 * Invite-Routen.
 *
 *   POST /admin/invites          — admin-only
 *   GET  /accept-invite/:token   — Redirect zu Google-Login mit Invite-Hint
 *
 * Multi-User Tier 1: nach createInvite() schicken wir eine Email an die
 * eingeladene Adresse. Bei EMAIL_PROVIDER=console wird die Email nicht
 * tatsaechlich versendet — sie landet in `email_outbox` und der Admin
 * sieht sie im PWA-Admin-Tab "Outbox".
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import { HttpError } from '../../lib/errors.js';
import { requireAdmin } from '../../middleware/auth.js';
import { createInvite } from '../../auth/invite/create.js';
import { createEmailOutboxService } from '../../services/email-outbox.js';
import { renderInviteEmail } from '../../auth/invite/email-template.js';

const createInviteSchema = z.object({
  email: z.string().email(),
  // P2-6 v2: optional bidirectional invite (signup + group-add Ceremony)
  target_group_id: z.string().uuid().optional(),
  target_group_role: z.enum(['admin', 'member']).optional(),
});

export function inviteRoutes(server: ServerContext): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const outbox = createEmailOutboxService({
    db: server.db,
    ...(server.email ? { email: server.email } : {}),
  });

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
        ...(body.target_group_id ? { targetGroupId: body.target_group_id } : {}),
        ...(body.target_group_role ? { targetGroupRole: body.target_group_role } : {}),
      });

      // Email-Versand (fail-soft: wenn das fail't, geht die Response trotzdem
      // mit acceptUrl raus damit der Admin manuell zustellen kann).
      const tpl = renderInviteEmail({
        acceptUrl: result.acceptUrl,
        expiresAt: result.expiresAt,
        invitedBy: principal.email,
        origin: server.config.ORIGIN,
      });
      const emailResult = await outbox.sendAndPersist({
        to: body.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        kind: 'invite',
        actorUserId: principal.userId,
        ...(server.config.EMAIL_REPLY_TO ? { replyTo: server.config.EMAIL_REPLY_TO } : {}),
      });

      return c.json(
        {
          inviteId: result.inviteId,
          acceptUrl: result.acceptUrl,
          expiresAt: result.expiresAt,
          email: {
            status: emailResult.status,
            outboxId: emailResult.outboxId,
            provider: emailResult.provider,
            errorDetail: emailResult.errorDetail,
          },
        },
        201,
      );
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
