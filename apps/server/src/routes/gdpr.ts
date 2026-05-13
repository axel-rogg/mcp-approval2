/**
 * GDPR-Routes — Self-Service Export + Erase.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.5 (Crypto-Shredding) + §11.2 (Offboarding).
 */

import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { AppBindings } from '../lib/context.js';
import { HttpError } from '../lib/errors.js';
import type { GdprService } from '../services/gdpr.js';

export interface GdprRouteDeps {
  gdpr: GdprService;
}

export function gdprRoutes(deps: GdprRouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  /**
   * GET /v1/gdpr/export
   * Liefert die kompletten User-Daten als NDJSON-Stream.
   * application/x-ndjson, eine Zeile = ein Record.
   */
  app.get('/export', async (c) => {
    const user = c.get('user');
    if (!user) throw new HttpError(401, 'unauthorized', 'authentication required');

    return stream(c, async (s) => {
      c.header('Content-Type', 'application/x-ndjson');
      c.header('Content-Disposition', `attachment; filename="gdpr-export-${user.userId}.ndjson"`);
      const records = deps.gdpr.exportUserData({
        userId: user.userId,
        actorUserId: user.userId,
        requestId: c.get('requestId'),
      });
      for await (const record of records) {
        await s.write(JSON.stringify(record) + '\n');
      }
    });
  });

  /**
   * DELETE /v1/gdpr/erase
   * Triggert Soft-Delete + 30-Tage-Grace. Reversibel via POST /v1/gdpr/erase/cancel.
   */
  app.delete('/erase', async (c) => {
    const user = c.get('user');
    if (!user) throw new HttpError(401, 'unauthorized', 'authentication required');

    const result = await deps.gdpr.requestErase({
      userId: user.userId,
      actorUserId: user.userId,
      requestId: c.get('requestId'),
    });

    return c.json({
      status: 'queued',
      purge_after_at: result.purgeAfterAt,
      grace_period_days: Math.round((result.purgeAfterAt - Date.now()) / (1000 * 60 * 60 * 24)),
      message:
        'Account zur Loeschung markiert. Bis zum purge_after_at-Datum kann die ' +
        'Anfrage via POST /v1/gdpr/erase/cancel zurueckgezogen werden.',
    });
  });

  /**
   * POST /v1/gdpr/erase/cancel
   * Zieht die Erase-Anfrage innerhalb der Grace-Period zurueck.
   */
  app.post('/erase/cancel', async (c) => {
    const user = c.get('user');
    if (!user) throw new HttpError(401, 'unauthorized', 'authentication required');

    await deps.gdpr.cancelErase({
      userId: user.userId,
      actorUserId: user.userId,
      requestId: c.get('requestId'),
    });
    return c.json({ status: 'cancelled' });
  });

  return app;
}
