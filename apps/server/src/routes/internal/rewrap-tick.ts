/**
 * P2-7 Rewrap-Tick-Proxy: GH-Actions-Cron → approval2 → Flycast → KC2.
 *
 * Kontext: KC2 ist post-Lockdown 2026-05-17 internal-only erreichbar
 * (kein public-Hostname, nur via approval2.fly-Network → flycast).
 * GH-Actions kann KC2 nicht direkt POSTen. Diese Route ist der
 * approval2-side-Proxy.
 *
 *   POST /internal/v1/rewrap-tick?max_jobs=&batch_size=
 *     Auth: Service-Token-Header (gleiche Middleware wie /internal/v1/*)
 *     Action: forward → KC2 /v1/internal/rewrap-tick (via MCP_KNOWLEDGE_URL)
 *     Response: 1:1 KC2-Response durchgereicht
 *
 * Wenn MCP_KNOWLEDGE_URL ungesetzt: 503. Wenn KC2-Call failt: 502 +
 * Error-Detail im Body.
 */
import { Hono } from 'hono';
import type { AppBindings, ServerContext } from '../../lib/context.js';

export interface RewrapTickProxyDeps {
  readonly server: ServerContext;
}

export function internalRewrapTickRoutes(
  deps: RewrapTickProxyDeps,
): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const { server } = deps;

  app.post('/internal/v1/rewrap-tick', async (c) => {
    const kcUrl = server.config.MCP_KNOWLEDGE_URL;
    const kcToken = server.config.MCP_KNOWLEDGE_SERVICE_TOKEN;
    if (!kcUrl || !kcToken) {
      return c.json(
        {
          error: {
            code: 'service_unavailable',
            message: 'MCP_KNOWLEDGE_URL or MCP_KNOWLEDGE_SERVICE_TOKEN not configured — KC2 proxy disabled',
          },
        },
        503,
      );
    }

    const url = new URL(c.req.url);
    const maxJobs = url.searchParams.get('max_jobs') ?? '5';
    const batchSize = url.searchParams.get('batch_size') ?? '100';
    const target = new URL(kcUrl);
    target.pathname = '/v1/internal/rewrap-tick';
    target.searchParams.set('max_jobs', maxJobs);
    target.searchParams.set('batch_size', batchSize);

    const startedAt = Date.now();
    try {
      const res = await fetch(target.toString(), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${kcToken}`,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      const body = await res.text();
      const durationMs = Date.now() - startedAt;
      if (!res.ok) {
        return c.json(
          {
            error: { code: 'kc_error', message: `KC2 ${res.status}: ${body.slice(0, 200)}` },
            duration_ms: durationMs,
          },
          502,
        );
      }
      // KC2-Response 1:1 weiterreichen
      try {
        return c.json({ ...JSON.parse(body), proxy_duration_ms: durationMs }, 200);
      } catch {
        return c.body(body, 200, { 'content-type': res.headers.get('content-type') ?? 'application/json' });
      }
    } catch (err) {
      return c.json(
        {
          error: {
            code: 'kc_unreachable',
            message: err instanceof Error ? err.message : String(err),
          },
        },
        502,
      );
    }
  });

  app.get('/internal/v1/rewrap-jobs', async (c) => {
    const kcUrl = server.config.MCP_KNOWLEDGE_URL;
    const kcToken = server.config.MCP_KNOWLEDGE_SERVICE_TOKEN;
    if (!kcUrl || !kcToken) {
      return c.json(
        { error: { code: 'service_unavailable', message: 'MCP_KNOWLEDGE_URL or MCP_KNOWLEDGE_SERVICE_TOKEN not configured' } },
        503,
      );
    }
    const url = new URL(c.req.url);
    const target = new URL(kcUrl);
    target.pathname = '/v1/internal/rewrap-jobs';
    for (const k of ['group_id', 'status', 'limit']) {
      const v = url.searchParams.get(k);
      if (v) target.searchParams.set(k, v);
    }
    try {
      const res = await fetch(target.toString(), {
        method: 'GET',
        headers: { authorization: `Bearer ${kcToken}` },
      });
      const body = await res.text();
      if (!res.ok) {
        return c.json(
          { error: { code: 'kc_error', message: `KC2 ${res.status}: ${body.slice(0, 200)}` } },
          502,
        );
      }
      return c.body(body, 200, {
        'content-type': res.headers.get('content-type') ?? 'application/json',
      });
    } catch (err) {
      return c.json(
        {
          error: {
            code: 'kc_unreachable',
            message: err instanceof Error ? err.message : String(err),
          },
        },
        502,
      );
    }
  });

  return app;
}
