/**
 * Sub-MCP-Wrapper-Tool-Factory.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.4, §9.
 *
 * Beim Boot iterieren wir alle enabled Sub-MCPs, bauen aus deren gecachten
 * `tools/list`-Antworten je einen Wrapper-Tool, der bei `tools/call` den
 * `SubMcpForwarder` ruft. Der User-JWT wird pro-Call signed (kurzlebig).
 *
 * Sensitivity-Default: 'write' (fail-closed). Siehe approval2/docs/security/
 * SECURITY_ISSUES.md SEC-006 — sub-MCP-Manifest darf nicht implizit als 'read'
 * angenommen werden, sonst kann ein schema-drift bei einem upstream-Sub-MCP
 * still die Approval-Wall umgehen.
 *
 * Sub-MCPs annotieren ihre Tools via `annotations.sensitivity` ODER mit den
 * MCP-Standard-Hints `readOnlyHint`/`destructiveHint`/`write`. Beide werden
 * respektiert. Unbekannte/fehlende Annotation → 'write'.
 */
import { z } from 'zod';
import type { AppConfig } from '../../lib/config.js';
import type { Tool, ToolContext } from '../protocol/tool.js';
import type { SubMcpForwarder } from './forwarder.js';
import type { SubMcpRegistry } from './registry.js';
import {
  buildForwardedToolDefs,
  type ForwardedToolDef,
  type SubMcpServerConfig,
} from './index.js';
import { signSubMcpUserJwt } from './user_jwt.js';
import type { ToolSensitivity } from '../protocol/tool.js';
import type { ToolAnnotations } from '../protocol/types.js';
import type { SubMcpAuthEnricher } from '../../services/sub-mcp-auth-enricher.js';

const SENSITIVITY_VALUES: ReadonlyArray<ToolSensitivity> = ['read', 'write', 'danger'];

/**
 * Resolves sensitivity for a forwarded sub-MCP tool. Fail-closed default 'write'.
 *
 * Precedence:
 *   1. annotations.sensitivity (explicit, three-valued enum)
 *   2. annotations.destructiveHint === true  → 'danger'
 *   3. annotations.write === true            → 'write'
 *   4. annotations.readOnlyHint === true     → 'read'
 *   5. default                               → 'write'  (fail-closed)
 */
export function resolveSubMcpSensitivity(annotations: ToolAnnotations | undefined): ToolSensitivity {
  if (!annotations) return 'write';
  const a = annotations as ToolAnnotations & {
    write?: unknown;
    sensitivity?: unknown;
  };
  if (typeof a.sensitivity === 'string' && SENSITIVITY_VALUES.includes(a.sensitivity as ToolSensitivity)) {
    return a.sensitivity as ToolSensitivity;
  }
  if (a.destructiveHint === true) return 'danger';
  if (a.write === true) return 'write';
  if (a.readOnlyHint === true) return 'read';
  return 'write';
}

export interface MakeForwardingToolArgs {
  readonly def: ForwardedToolDef;
  readonly forwarder: SubMcpForwarder;
  readonly config: Pick<AppConfig, 'JWT_SECRET' | 'JWT_ISSUER'>;
  /**
   * Optional Auth-Enricher — injiziert per-User-Auth-Header (z.B.
   * x-google-access-token fuer gws, x-gcp-sa-json fuer gcloud).
   * Wenn fehlend: nur Standard-Header (Schicht-1 + X-User-JWT).
   */
  readonly authEnricher?: SubMcpAuthEnricher;
}

/**
 * Build a registry-ready Tool that forwards to a sub-MCP via SubMcpForwarder.
 * Tool-name follows the naming convention from buildForwardedToolDefs:
 * `<subMcpName>.<remoteToolName>` (e.g. `gws.calendar.list`, `utils.diagram.info`).
 */
export function makeForwardingTool(args: MakeForwardingToolArgs): Tool<unknown, unknown> {
  const { def, forwarder, config, authEnricher } = args;
  const sensitivity = resolveSubMcpSensitivity(def.annotations);

  const tool: Tool<unknown, unknown> = {
    name: def.name,
    description: def.description,
    sensitivity,
    inputSchema: z.unknown() as z.ZodType<unknown>,
    ...(def.annotations ? { annotations: def.annotations } : {}),
    async execute(ctx: ToolContext, input: unknown): Promise<unknown> {
      const userJwt = await signSubMcpUserJwt({
        userId: ctx.userId,
        subMcpName: def.subMcpName,
        config,
      });
      // Auth-Enricher liefert ggf. extra Headers (Google-Access-Token,
      // SA-JSON, etc.). Wenn der Enricher leer-Map liefert (z.B. weil User
      // noch nichts konfiguriert hat), faellt der Worker auf seinen Legacy-
      // Pfad zurueck. Wenn der Enricher ueberhaupt nicht verkabelt ist,
      // bleibt das alte Pre-Multiuser-Verhalten.
      let extraHeaders: Record<string, string> | undefined;
      if (authEnricher) {
        try {
          const headers = await authEnricher.enrich({
            userId: ctx.userId,
            subMcpName: def.subMcpName,
          });
          if (Object.keys(headers).length > 0) extraHeaders = headers;
        } catch (err) {
          // Enricher-Fehler ist nicht fatal — Worker-Legacy-Pfad uebernimmt.
          // Wir loggen aber damit User-Feedback ankommt.
          // eslint-disable-next-line no-console
          console.warn(
            `[wrapper_tools] auth-enricher failed for sub-mcp '${def.subMcpName}', ` +
              `falling back to legacy auth on worker: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return forwarder.forwardToolCall({
        subMcpName: def.subMcpName,
        toolName: def.remoteName,
        input,
        userJwt,
        ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(extraHeaders ? { extraHeaders } : {}),
      });
    },
  };
  return tool;
}

export interface BuildSubMcpWrapperToolsArgs {
  readonly registry: SubMcpRegistry;
  readonly forwarder: SubMcpForwarder;
  readonly config: Pick<AppConfig, 'JWT_SECRET' | 'JWT_ISSUER'>;
  /** Optional Auth-Enricher fuer per-User-Header. */
  readonly authEnricher?: SubMcpAuthEnricher;
}

export interface BuildSubMcpWrapperToolsResult {
  readonly tools: ReadonlyArray<Tool<unknown, unknown>>;
  /** Tool-Namen die wegen ungueltigem Naming-Pattern uebersprungen wurden. */
  readonly skipped: ReadonlyArray<string>;
  /** Pro Sub-MCP die Anzahl registrierter Wrapper-Tools (fuer Diagnose-Log). */
  readonly perSubMcp: ReadonlyMap<string, number>;
}

/**
 * Iterate alle enabled Sub-MCPs, baue pro gecachten Tool einen Wrapper.
 * Sub-MCPs ohne `toolsCache` (noch nie discovered) werden uebersprungen — der
 * Discovery-Cron muss sie erst befuellen.
 */
export async function buildSubMcpWrapperTools(
  args: BuildSubMcpWrapperToolsArgs,
): Promise<BuildSubMcpWrapperToolsResult> {
  const enabled = await args.registry.listEnabled();
  const tools: Tool<unknown, unknown>[] = [];
  const skipped: string[] = [];
  const perSubMcp = new Map<string, number>();
  for (const cfg of enabled) {
    const count = appendToolsForServer(
      cfg,
      args.forwarder,
      args.config,
      tools,
      skipped,
      args.authEnricher,
    );
    perSubMcp.set(cfg.name, count);
  }
  return { tools, skipped, perSubMcp };
}

function appendToolsForServer(
  cfg: SubMcpServerConfig,
  forwarder: SubMcpForwarder,
  config: Pick<AppConfig, 'JWT_SECRET' | 'JWT_ISSUER'>,
  out: Tool<unknown, unknown>[],
  skipped: string[],
  authEnricher?: SubMcpAuthEnricher,
): number {
  if (!cfg.toolsCache || cfg.toolsCache.length === 0) return 0;
  const { defs, skipped: defSkipped } = buildForwardedToolDefs(cfg);
  skipped.push(...defSkipped);
  for (const def of defs) {
    out.push(
      makeForwardingTool({
        def,
        forwarder,
        config,
        ...(authEnricher ? { authEnricher } : {}),
      }),
    );
  }
  return defs.length;
}
