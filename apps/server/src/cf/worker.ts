/**
 * Cloudflare Workers entry-point.
 *
 * This is the EDGE-RUNTIME pendant to `apps/server/src/index.ts` (Node).
 * It does NOT import from `index.ts` because that file pulls
 * `@hono/node-server` + `process.argv` boot hooks that don't exist on Workers.
 *
 * Architecture differences vs Node entry — see ./README.md.
 */
import type { ExecutionContext } from '@cloudflare/workers-types';
import type { Hono } from 'hono';
import type { AppBindings } from '../lib/context.js';

import { createCfApp, type CfEnv } from './app-factory-cf.js';

// Hono apps cache themselves between requests for the lifetime of the
// isolate. Building the app on every request would re-run the full
// adapter+service wireup; instead we build once and reuse.
let cachedApp: Hono<AppBindings> | null = null;

async function getApp(env: CfEnv): Promise<Hono<AppBindings>> {
  if (cachedApp) return cachedApp;
  cachedApp = await createCfApp(env);
  return cachedApp;
}

export default {
  async fetch(
    request: Request,
    env: CfEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const app = await getApp(env);
    return app.fetch(request, env, ctx);
  },
};

export type { CfEnv } from './app-factory-cf.js';
