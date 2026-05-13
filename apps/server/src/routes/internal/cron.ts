/**
 * Internal Cron-Trigger-Routes — externe Scheduler triggern hier.
 *
 *   POST /internal/v1/cron/:task
 *     Auth: Service-Token (Middleware mountet auf /internal/v1/*)
 *     Response: { task, executed_at, duration_ms, result }
 *
 * Plan-Ref: PLAN-architecture-v1.md §7.3 (Scheduling).
 *
 * Pattern: identisch zu /internal/v1/dek + /internal/v1/credentials — service-token-
 * gated, kein User-Context. Audit-Logging passiert pro Task im Handler.
 */
import { Hono } from 'hono';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import { HttpError } from '../../lib/errors.js';
import { emitAudit } from '../../services/audit.js';
import {
  CRON_TASKS,
  UnknownCronTaskError,
  runCronTask,
  type CronDeps,
  type CronTask,
} from '../../cron/index.js';

export interface InternalCronRouteDeps {
  readonly server: ServerContext;
  readonly cronDeps: Omit<CronDeps, 'db'>;
}

export function internalCronRoutes(deps: InternalCronRouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const { server } = deps;

  app.get('/internal/v1/cron', (c) => {
    return c.json({ tasks: CRON_TASKS });
  });

  app.post('/internal/v1/cron/:task', async (c) => {
    const task = c.req.param('task');
    const startedAt = Date.now();
    try {
      const result = await runCronTask(task, { db: server.db, ...deps.cronDeps });
      const durationMs = Date.now() - startedAt;
      return c.json({
        task: task as CronTask,
        executed_at: startedAt,
        duration_ms: durationMs,
        result,
      });
    } catch (err) {
      if (err instanceof UnknownCronTaskError) {
        await emitAudit(server.db, {
          action: 'cron.unknown_task',
          actorUserId: null,
          result: 'failure',
          details: { task },
        });
        throw HttpError.notFound(`unknown cron task: ${task}`);
      }
      const durationMs = Date.now() - startedAt;
      await emitAudit(server.db, {
        action: 'cron.dispatch_error',
        actorUserId: null,
        result: 'failure',
        details: {
          task,
          duration_ms: durationMs,
          error: err instanceof Error ? err.message : 'unknown',
        },
      });
      throw err;
    }
  });

  return app;
}
