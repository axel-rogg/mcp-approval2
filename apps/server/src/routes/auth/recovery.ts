/**
 * Email-Magic-Link-Recovery-Routen.
 *
 *   POST /auth/recovery/request   — { email } → Magic-Link sent
 *   GET  /auth/recovery/verify    — ?token=... → invalidate passkeys + Re-Auth-Redirect
 *
 * Multi-User Tier 1 (2026-05-17): Email-Versand via EmailOutboxService.
 * Bei unknown-email senden wir KEINE Email (no enumeration leak).
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import { HttpError } from '../../lib/errors.js';
import { requestRecovery, verifyRecovery } from '../../auth/recovery/email.js';
import { createEmailOutboxService } from '../../services/email-outbox.js';
import { renderRecoveryEmail } from '../../auth/recovery/email-template.js';

const requestSchema = z.object({
  email: z.string().email(),
});

export function recoveryRoutes(server: ServerContext): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const outbox = createEmailOutboxService({
    db: server.db,
    ...(server.email ? { email: server.email } : {}),
  });

  app.post('/auth/recovery/request', zValidator('json', requestSchema), async (c) => {
    const body = c.req.valid('json');
    const result = await requestRecovery(server.db, server.config, { email: body.email });

    // Email nur senden wenn requestRecovery einen User gefunden hat
    // (sonst leakt der Outbox-Eintrag die User-Existenz).
    if (result.userFound) {
      const tpl = renderRecoveryEmail({
        verifyUrl: result.verifyUrl,
        expiresAt: result.expiresAt,
        origin: server.config.ORIGIN,
      });
      await outbox.sendAndPersist({
        to: body.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        kind: 'recovery',
        ...(result.userId ? { toUserId: result.userId } : {}),
        ...(server.config.EMAIL_REPLY_TO ? { replyTo: server.config.EMAIL_REPLY_TO } : {}),
      });
    }

    // Production: NIE rawToken zurueckgeben — nur per Email senden.
    // Dev/Test: rawToken im Body fuer Smoke-Tests.
    const payload: { ok: true; expiresAt: number; rawToken?: string } = {
      ok: true,
      expiresAt: result.expiresAt,
    };
    if (server.config.NODE_ENV !== 'production') payload.rawToken = result.rawToken;
    return c.json(payload);
  });

  app.get('/auth/recovery/verify', async (c) => {
    const token = c.req.query('token');
    if (!token) throw HttpError.badRequest('invalid_request', 'missing token');
    const result = await verifyRecovery(server.db, token);
    // Nach Verify: User wird auf Google-OAuth umgeleitet, damit er sich
    // re-auth'd und dann Passkey neu enrollen kann.
    const startUrl = new URL('/auth/google/start', server.config.ORIGIN);
    startUrl.searchParams.set('recovery', '1');
    return c.json({
      ok: true,
      userId: result.userId,
      mustReenroll: result.mustReenroll,
      next: startUrl.toString(),
    });
  });

  return app;
}
