/**
 * GET /health — liveness + version stamp.
 */
import { Hono } from 'hono';
import type { AppBindings } from '../lib/context.js';

export function healthRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      service: 'mcp-approval2',
      now: Date.now(),
      requestId: c.get('requestId'),
    }),
  );
  return app;
}
