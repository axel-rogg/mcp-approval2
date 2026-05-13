/**
 * Push-HTTP-Routes.
 *
 *   POST   /v1/push/subscribe         — register a WebPush subscription
 *   POST   /v1/push/unsubscribe       — remove a subscription by id
 *   GET    /v1/push/subscriptions     — list owned subscriptions (no secrets)
 *   POST   /v1/push/test              — send a generic test push to all subs
 *   GET    /v1/push/vapid             — return VAPID public key (no auth)
 *
 * Plan-Ref: PLAN-architecture-v1.md §7.
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppBindings } from '../lib/context.js';
import { HttpError } from '../lib/errors.js';
import { auth } from '../middleware/auth.js';
import type { PushService, PushServiceEnv } from '../services/push.js';
import type { ServerContext } from '../lib/context.js';

export interface PushRouteDeps {
  readonly server: ServerContext;
  readonly push: PushService;
  readonly vapidEnv: Pick<PushServiceEnv, 'VAPID_PUBLIC_KEY'>;
}

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(64),
  }),
  userAgent: z.string().max(512).optional(),
});

const unsubscribeSchema = z.object({
  subscriptionId: z.string().uuid(),
});

const testSchema = z
  .object({
    title: z.string().min(1).max(120).optional(),
    body: z.string().min(1).max(500).optional(),
  })
  .optional();

export function pushRoutes(deps: PushRouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const { server, push, vapidEnv } = deps;

  // Public: VAPID public key (not secret, needed by PWA before push.subscribe).
  app.get('/v1/push/vapid', (c) => {
    if (!vapidEnv.VAPID_PUBLIC_KEY) {
      throw new HttpError(503, 'internal', 'vapid_unavailable');
    }
    return c.json({ publicKey: vapidEnv.VAPID_PUBLIC_KEY });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Auth-protected
  // ─────────────────────────────────────────────────────────────────────
  app.use('/v1/push/subscribe', auth(server, { required: true }));
  app.use('/v1/push/unsubscribe', auth(server, { required: true }));
  app.use('/v1/push/subscriptions', auth(server, { required: true }));
  app.use('/v1/push/test', auth(server, { required: true }));

  app.post('/v1/push/subscribe', zValidator('json', subscribeSchema), async (c) => {
    const user = c.get('user');
    if (!user) throw HttpError.unauthorized('authentication required');
    const body = c.req.valid('json');
    const subscribeArgs: Parameters<PushService['subscribe']>[0] = {
      userId: user.userId,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
    };
    if (body.userAgent !== undefined) {
      (subscribeArgs as { userAgent?: string }).userAgent = body.userAgent;
    }
    const result = await push.subscribe(subscribeArgs);
    return c.json({ id: result.id }, 201);
  });

  app.post('/v1/push/unsubscribe', zValidator('json', unsubscribeSchema), async (c) => {
    const user = c.get('user');
    if (!user) throw HttpError.unauthorized('authentication required');
    const body = c.req.valid('json');
    await push.unsubscribe({ userId: user.userId, subscriptionId: body.subscriptionId });
    return c.json({ ok: true });
  });

  app.get('/v1/push/subscriptions', async (c) => {
    const user = c.get('user');
    if (!user) throw HttpError.unauthorized('authentication required');
    const subs = await push.listSubscriptions({ userId: user.userId });
    // Don't leak p256dh/auth in metadata listing — only id/endpoint-prefix/created/lastUsed.
    return c.json({
      subscriptions: subs.map((s) => ({
        id: s.id,
        endpoint_prefix: s.endpoint.slice(0, 60),
        user_agent: s.userAgent,
        created_at: s.createdAt,
        last_used_at: s.lastUsedAt,
      })),
    });
  });

  app.post('/v1/push/test', zValidator('json', testSchema), async (c) => {
    const user = c.get('user');
    if (!user) throw HttpError.unauthorized('authentication required');
    const body = c.req.valid('json') ?? {};
    const result = await push.send({
      userId: user.userId,
      payload: {
        title: body.title ?? 'mcp-approval2',
        body: body.body ?? 'Test notification',
      },
      urgency: 'high',
    });
    return c.json(result);
  });

  return app;
}
