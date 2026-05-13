/**
 * Cron-Dispatcher — switch nach Task-Name → konkreter Handler.
 *
 * Plan-Ref: PLAN-architecture-v1.md §7.3 (Scheduling). External-Scheduler-Pattern:
 * mcp-approval2 lebt im Node-Worker-Modell ohne eigene Cron-Runtime. Stattdessen
 * triggert ein externer Scheduler (systemd-timer / k8s-CronJob / GH-Actions /
 * jeglicher Cron) per HTTP-POST auf `/internal/v1/cron/:task` und WIR fuehren
 * den Task im Server-Process aus.
 *
 * Vorteile gegenueber in-process-Cron:
 *   - Single-Source-of-Truth fuer Scheduling (kein Code-Deploy fuer Schedule-
 *     Anpassung).
 *   - Mehrere App-Instanzen koennen sich nicht doppelt triggern.
 *   - Pause / Manual-Run / Per-Task-Logs out-of-the-box.
 *
 * Task-Inventar (siehe `CRON_TASKS`):
 *   - auto-archive-apps         daily — alte/inactive Apps in Archive verschieben
 *   - purge-trashed-apps        daily — soft-deleted Apps nach 30d hart loeschen
 *   - sweep-executing-approvals 5min  — stuck `executing` approvals expiren
 *   - sweep-output-refs         daily — TTL-cached Tool-Outputs raeumen
 *   - sweep-prf-sessions        hourly— expired PRF-Sessions (in-memory only -- noop bei In-Memory-Store)
 *   - gateway-discovery         hourly— Sub-MCP-Tool-Cache refreshen
 *   - reminders                 5min  — Apps-Reminder-Blocks dispatchen
 *
 * Pro Task ein eigenes Handler-File mit `runTask(deps): Promise<TaskResult>`.
 * Diese Datei selbst macht nur Routing — sie kennt keinen DB-Code.
 */
import type { DbAdapter } from '@mcp-approval2/adapters';
import type { ApprovalService } from '../services/approvals.js';
import type { PushService } from '../services/push.js';
import type { PrfSessionService } from '../services/prf-session.js';
import type { SubMcpRegistry } from '../mcp/gateway/registry.js';
import { runAutoArchiveApps } from './auto-archive-apps.js';
import { runPurgeTrashedApps } from './purge-trashed-apps.js';
import { runSweepExecutingApprovals } from './sweep-executing-approvals.js';
import { runSweepOutputRefs } from './sweep-output-refs.js';
import { runSweepPrfSessions } from './sweep-prf-sessions.js';
import { runGatewayDiscovery } from './gateway-discovery.js';
import { runReminders } from './reminders.js';

export const CRON_TASKS = [
  'auto-archive-apps',
  'purge-trashed-apps',
  'sweep-executing-approvals',
  'sweep-output-refs',
  'sweep-prf-sessions',
  'gateway-discovery',
  'reminders',
] as const;

export type CronTask = (typeof CRON_TASKS)[number];

export function isCronTask(s: string): s is CronTask {
  return (CRON_TASKS as ReadonlyArray<string>).includes(s);
}

/**
 * Pro-Task-Result. Wird vom HTTP-Wrapper in `{ task, executed_at, duration_ms, result }`
 * eingewickelt.
 */
export interface TaskResult {
  /** Zaehler oder strukturierte Details — task-spezifisch. */
  readonly [key: string]: unknown;
}

export interface CronDeps {
  readonly db: DbAdapter;
  readonly approvals?: ApprovalService;
  readonly push?: PushService;
  readonly prfSessions?: PrfSessionService;
  readonly subMcpRegistry?: SubMcpRegistry;
  /** Override fuer Tests. */
  readonly fetchImpl?: typeof fetch;
  /** Override fuer Tests / deterministische Zeit. */
  readonly now?: () => number;
}

/**
 * Dispatcher. Wirft `UnknownCronTaskError` wenn `task` nicht in CRON_TASKS.
 */
export async function runCronTask(task: string, deps: CronDeps): Promise<TaskResult> {
  if (!isCronTask(task)) {
    throw new UnknownCronTaskError(task);
  }
  switch (task) {
    case 'auto-archive-apps':
      return runAutoArchiveApps(deps);
    case 'purge-trashed-apps':
      return runPurgeTrashedApps(deps);
    case 'sweep-executing-approvals':
      return runSweepExecutingApprovals(deps);
    case 'sweep-output-refs':
      return runSweepOutputRefs(deps);
    case 'sweep-prf-sessions':
      return runSweepPrfSessions(deps);
    case 'gateway-discovery':
      return runGatewayDiscovery(deps);
    case 'reminders':
      return runReminders(deps);
  }
}

export class UnknownCronTaskError extends Error {
  override readonly name = 'UnknownCronTaskError';
  constructor(public readonly task: string) {
    super(`unknown cron task: ${task}`);
  }
}
