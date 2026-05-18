/**
 * Route: /v1/me/settings — Per-User Agent-Settings (key/value-Store).
 *
 * Plan-Ref: docs/plans/active/PLAN-tool-defaults-v2.md (Phase E).
 * Service: UserSettingsService (services/user-settings.ts).
 *
 * Endpoints:
 *   GET    /v1/me/settings                — list all
 *   GET    /v1/me/settings/:key           — get one
 *   PUT    /v1/me/settings/:key           body: {value: <unknown>}
 *   DELETE /v1/me/settings/:key
 *
 * Heute hauptsaechlich fuer `elicit_on_missing_defaults` (Plan §10 Entscheidung ②).
 * Generisch genug fuer kuenftige Settings (UI-Themes, Notification-Toggles).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import { HttpError } from '../../lib/errors.js';
import { auth } from '../../middleware/auth.js';
import type { UserSettingsService } from '../../services/user-settings.js';

const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

export interface MySettingsRouteDeps {
  readonly server: ServerContext;
  readonly settings: UserSettingsService;
}

export function mySettingsRoutes(deps: MySettingsRouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const guard = auth(deps.server);

  const PutBody = z
    .object({
      value: z.unknown(),
    })
    .strict();

  app.get('/v1/me/settings', guard, async (c) => {
    const user = c.get('user');
    if (!user) throw HttpError.unauthorized('authentication required');
    const list = await deps.settings.list(user.userId);
    return c.json({ settings: list });
  });

  app.get('/v1/me/settings/:key', guard, async (c) => {
    const user = c.get('user');
    if (!user) throw HttpError.unauthorized('authentication required');
    const key = c.req.param('key');
    if (!KEY_RE.test(key)) {
      throw HttpError.badRequest('invalid_request', `invalid key '${key}'`);
    }
    const entry = await deps.settings.get(user.userId, key);
    if (entry === null) {
      throw HttpError.notFound(`setting '${key}' not set`);
    }
    return c.json(entry);
  });

  app.put('/v1/me/settings/:key', guard, zValidator('json', PutBody), async (c) => {
    const user = c.get('user');
    if (!user) throw HttpError.unauthorized('authentication required');
    const key = c.req.param('key');
    if (!KEY_RE.test(key)) {
      throw HttpError.badRequest('invalid_request', `invalid key '${key}'`);
    }
    const body = c.req.valid('json');
    const entry = await deps.settings.set(user.userId, key, body.value);
    return c.json(entry);
  });

  app.delete('/v1/me/settings/:key', guard, async (c) => {
    const user = c.get('user');
    if (!user) throw HttpError.unauthorized('authentication required');
    const key = c.req.param('key');
    if (!KEY_RE.test(key)) {
      throw HttpError.badRequest('invalid_request', `invalid key '${key}'`);
    }
    await deps.settings.remove(user.userId, key);
    return c.body(null, 204);
  });

  return app;
}
