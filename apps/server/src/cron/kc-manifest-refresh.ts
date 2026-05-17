/**
 * Cron-Task: KC2-Manifest-Refresh (5min-Cadence).
 *
 * Plan-Ref: PLAN-as3-autonomous.md §1.4 + A9.
 *
 * Verantwortung:
 *   - KC2-Manifest neu fetchen (POST /mcp tools/list).
 *   - Wrappers neu generieren mit selbem Signer/SERVICE_TOKEN-Material.
 *   - Im Tool-Registry: alte Wrappers entfernen, neue registrieren.
 *
 * Race-Safety:
 *   - Wenn KC2 transient unreachable ist: noop + audit (keine alten
 *     Wrappers werden entfernt, sodass die Tools-Surface stabil bleibt
 *     bis das naechste Refresh klappt).
 *
 * Audit-Event: `cron.kc_manifest_refresh` mit `tools_count`, `added`,
 * `removed`, `error?`.
 *
 * Dispatch:
 *   - Wird vom externen Scheduler getriggert (siehe cron/index.ts —
 *     Pattern wie `gateway-discovery`).
 *   - Im wrangler.jsonc / k8s-CronJob als every-5-min planen
 *     (Cron-Expression: zero-fifth-star-star-star).
 */
import type { CronDeps, TaskResult } from './index.js';
import { emitAudit } from '../services/audit.js';
import {
  buildKcWrappers,
  type BuildKcWrappersOpts,
} from '../tools/kc_wrappers/index.js';
import type { ToolRegistry } from '../mcp/protocol/registry.js';
import type { Tool } from '../mcp/protocol/tool.js';

/**
 * Optional-Felder die kc-manifest-refresh zusaetzlich zu CronDeps
 * braucht. Werden ueber CronDeps-Extension uebergeben (siehe
 * index.ts und app-factory.ts mountet das via internalCronRoutes).
 */
export interface KcManifestRefreshDeps {
  readonly registry: ToolRegistry;
  /**
   * Vorhandener Bauplan (vom Boot). Wir nutzen `opts` 1:1, ersetzen
   * nur die zurueckgegebenen Tools.
   */
  readonly previousOpts: BuildKcWrappersOpts;
  /** Aktuelle Tool-Liste (zum diff/remove). */
  readonly previousTools: ReadonlyArray<Tool<unknown, unknown>>;
  /** Callback um die neue Liste in den Boot-Cache zu schreiben. */
  readonly onUpdated: (entry: {
    tools: ReadonlyArray<Tool<unknown, unknown>>;
    manifest: import('../tools/kc_wrappers/index.js').KcManifest;
  }) => void;
}

export interface KcManifestRefreshResult extends TaskResult {
  readonly tools_count: number;
  readonly added: number;
  readonly removed: number;
  readonly error?: string;
}

export async function runKcManifestRefresh(
  deps: CronDeps & { kcManifest?: KcManifestRefreshDeps },
): Promise<KcManifestRefreshResult> {
  if (!deps.kcManifest) {
    await emitAudit(deps.db, {
      action: 'cron.kc_manifest_refresh',
      actorUserId: null,
      result: 'noop',
      details: { reason: 'kc_manifest_deps_unavailable' },
    });
    return { tools_count: 0, added: 0, removed: 0 };
  }
  const { registry, previousOpts, previousTools, onUpdated } = deps.kcManifest;

  let added = 0;
  let removed = 0;
  let toolsCount = 0;
  try {
    const { tools: nextTools, manifest } = await buildKcWrappers(previousOpts);
    toolsCount = nextTools.length;

    // Bei leerer Liste: kein blind-replace — KC2 koennte gerade down
    // sein. Audit + noop.
    if (nextTools.length === 0 && previousTools.length > 0) {
      await emitAudit(deps.db, {
        action: 'cron.kc_manifest_refresh',
        actorUserId: null,
        result: 'noop',
        details: {
          reason: 'kc2_returned_empty_manifest_keeping_existing',
          previous_count: previousTools.length,
        },
      });
      return { tools_count: previousTools.length, added: 0, removed: 0 };
    }

    // Diff old vs new — by tool name.
    const oldNames = new Set(previousTools.map((t) => t.name));
    const newNames = new Set(nextTools.map((t) => t.name));

    // Remove tools that disappeared from KC2 (or got renamed).
    for (const t of previousTools) {
      if (!newNames.has(t.name) && registry.has(t.name)) {
        registry.unregister(t.name);
        removed += 1;
      }
    }
    // Register new + replace existing.
    for (const t of nextTools) {
      if (oldNames.has(t.name) && registry.has(t.name)) {
        // Replace.
        registry.unregister(t.name);
      } else {
        added += 1;
      }
      registry.register(t);
    }

    onUpdated({ tools: nextTools, manifest });

    await emitAudit(deps.db, {
      action: 'cron.kc_manifest_refresh',
      actorUserId: null,
      result: 'success',
      details: {
        tools_count: toolsCount,
        added,
        removed,
      },
    });
    return { tools_count: toolsCount, added, removed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await emitAudit(deps.db, {
      action: 'cron.kc_manifest_refresh',
      actorUserId: null,
      result: 'failure',
      details: { error: message },
    });
    return { tools_count: previousTools.length, added: 0, removed: 0, error: message };
  }
}
