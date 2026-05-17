/**
 * kc_wrappers/ — Auto-generierte Wrappers fuer KC2-Tools.
 *
 * Plan-Ref: PLAN-as3-autonomous.md §1.4 (Auto-Generator), §1.2 (OBO-Auth),
 *           §1.5 (approval_id-Routing), A-D2 (Approval-Pflicht aus Manifest).
 *
 * Lifecycle:
 *   1. `buildKcWrappers(opts)` fetched KC2's tools/list, parsed das
 *      Manifest, baut fuer jedes Tool ein `Tool<unknown, ...>`-Objekt.
 *      Annotations werden 1:1 uebernommen, plus:
 *        - `sensitivity` aus `annotations.write===true` → 'write'/'danger',
 *          sonst aus `annotations.sensitivity` oder 'read'.
 *        - `displayTemplate` aus `annotations.displayTemplate` (KC2-Manifest
 *          liefert das auch).
 *   2. Handler ruft `forwardToKc(...)` mit OBO-Auth → KC2 `tools/call`.
 *   3. KC2-Response (content[]) wird 1:1 ans MCP-Client zurueckgegeben.
 *
 * Approval-Routing (A-D2):
 *   - Manifest-Annotation `write===true` ODER `sensitivity='write'|'danger'`
 *     → Tool ist approval-pflichtig (sensitivity entsprechend).
 *   - Override-Liste in approval2-Config: nur OBEN (override-up) — wenn KC2
 *     ein Tool als 'read' annotated, koennen wir es auf 'write' hochstufen.
 *     Override-down (write → read) wird NICHT akzeptiert.
 *
 * IPI-Fence:
 *   - `annotations.user_content===true` (= Tool gibt User-Content zurueck
 *     der durch IPI-Filter muss). Wir setzen entsprechend `requiredScopes`
 *     bzw. einen Annotations-Flag — der existierende IPI-Filter in
 *     mcp/protocol/registry.ts beachtet das beim Dispatch.
 *
 * Graceful:
 *   - Wenn `MCP_KNOWLEDGE_URL` nicht gesetzt → empty array, kein Mount.
 *   - Wenn KC2 unreachable beim Boot → empty array + warning, app startet
 *     trotzdem.
 *   - 5-min Refresh-Cron erzeugt einen neuen Wrapper-Set; alte Tools
 *     werden ersetzt (via registry.replace falls noetig).
 */
import { z } from 'zod';
import type { JwtSigner } from '@mcp-approval2/adapters';
import type {
  ToolAnnotations,
  ToolResultContent,
} from '../../mcp/protocol/types.js';
import type { Tool, ToolContext, ToolSensitivity } from '../../mcp/protocol/tool.js';
import { fetchKcManifest, type KcManifest, type KcToolManifestEntry } from './manifest-client.js';
import { forwardToKc } from './forward.js';

export interface BuildKcWrappersOpts {
  readonly knowledgeUrl: string;
  readonly serviceToken: string;
  readonly signer: JwtSigner;
  readonly fetchImpl?: typeof fetch;
  /**
   * Optional Override-Liste: pro-Tool sensitivity-up.
   * Beispiel: `{ 'objects.create': 'danger' }` — auch wenn KC2 'write'
   * annotated, behandeln wir es als 'danger' (zusaetzliche WebAuthn-PRF-
   * Anforderung).
   */
  readonly sensitivityOverrides?: Readonly<Record<string, ToolSensitivity>>;
  /** Timeout fuer das initiale manifest-fetch in ms (Default 5000). */
  readonly manifestTimeoutMs?: number;
}

export interface BuildKcWrappersResult {
  readonly tools: ReadonlyArray<Tool<unknown, unknown>>;
  readonly manifest: KcManifest;
}

/**
 * Build der Wrappers aus dem aktuellen Manifest. Graceful: bei Fehler
 * leeres Array + log warning.
 */
export async function buildKcWrappers(
  opts: BuildKcWrappersOpts,
): Promise<BuildKcWrappersResult> {
  let manifest: KcManifest;
  try {
    manifest = await fetchKcManifest({
      knowledgeUrl: opts.knowledgeUrl,
      serviceToken: opts.serviceToken,
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.manifestTimeoutMs !== undefined
        ? { timeoutMs: opts.manifestTimeoutMs }
        : {}),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[mcp-approval2] kc_wrappers: failed to fetch manifest from ${opts.knowledgeUrl}: ${
        err instanceof Error ? err.message : String(err)
      }. Continuing without KC-Wrappers.`,
    );
    return { tools: [], manifest: { tools: [], fetchedAt: Date.now() } };
  }

  const tools: Tool<unknown, unknown>[] = [];
  for (const entry of manifest.tools) {
    tools.push(buildOneWrapper(entry, opts));
  }
  return { tools, manifest };
}

function buildOneWrapper(
  entry: KcToolManifestEntry,
  opts: BuildKcWrappersOpts,
): Tool<unknown, unknown> {
  const annotations: ToolAnnotations = entry.annotations ?? {};
  // Sensitivity-Resolution: Manifest-Annotation, dann Override-up.
  // SEC-006: resolveSensitivity defaultet auf 'write' (fail-closed) wenn das
  // KC2-Tool-Manifest keine `sensitivity`-Annotation traegt.
  let sensitivity: ToolSensitivity = resolveSensitivity(annotations, entry.name);
  const override = opts.sensitivityOverrides?.[entry.name];
  if (override !== undefined) {
    // Override-up only — down ablehnen.
    if (rankSensitivity(override) > rankSensitivity(sensitivity)) {
      sensitivity = override;
    }
  }

  // Display-Template-Resolution (cross-service contract):
  // KC2-Manifest publishes `annotations.wysiwys.display_template` (snake_case,
  // nested — per knowledge2/PLAN-as3-autonomous.md §1.4). approval2's
  // ToolAnnotations.displayTemplate is the flat camelCase consumer. Bridge
  // both shapes here so the contract test
  // `tests/contract/manifest-roundtrip.test.ts` stays green.
  const annotationsAny = annotations as ToolAnnotations & {
    wysiwys?: { display_template?: string };
    display_template?: string;
  };
  const displayTemplate =
    annotationsAny.displayTemplate ??
    annotationsAny.wysiwys?.display_template ??
    annotationsAny.display_template;

  // Input-Schema-Adapter: Manifest liefert JsonSchema, unser Tool-Type
  // erwartet `z.ZodType`. Wir verwenden ein passthrough-Schema, das
  // alles akzeptiert — KC2 macht die echte Validierung. Das ist die
  // Konvention aus v1 (`kc_wrappers/*`-Pattern).
  const inputSchema = z.unknown();

  const tool: Tool<unknown, unknown> = {
    name: entry.name,
    description: entry.description,
    sensitivity,
    inputSchema,
    ...(displayTemplate ? { displayTemplate } : {}),
    annotations,
    async execute(ctx: ToolContext, input: unknown): Promise<ToolResultContent[]> {
      const userEmail = ctx.email; // ToolContext.email ist nie undefined
      const result = await forwardToKc({
        knowledgeUrl: opts.knowledgeUrl,
        serviceToken: opts.serviceToken,
        signer: opts.signer,
        toolName: entry.name,
        arguments: isObjectRecord(input) ? input : { _input: input },
        userId: ctx.userId,
        userEmail,
        requestId: ctx.requestId,
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
        ...(ctx.approvalId !== undefined ? { approvalId: ctx.approvalId } : {}),
      });
      return result.content;
    },
  };
  return tool;
}

/**
 * SEC-006: fail-closed Sensitivity-Default fuer kc_wrappers.
 *
 * Begruendung: KC2 wird in einem separaten Repo gepflegt; bei jedem Tools-
 * Discovery-Refresh (cron every 5 min) koennten neue schreibende Tools auftauchen,
 * die im Manifest VERGESSEN haben `annotations.sensitivity='write'` zu setzen.
 * Wenn wir dann fail-OPEN auf 'read' defaulten, wuerde `registry.dispatch`
 * die Approval-Wall ueberspringen und der MCP-Client koennte das Tool ohne
 * User-Verification aufrufen.
 *
 * Fail-CLOSED-Regel: Sensitivity wird in dieser Reihenfolge bestimmt:
 *   1. Explizites `sensitivity` (read/write/danger).
 *   2. `destructiveHint=true` → danger.
 *   3. `write=true` → write.
 *   4. `readOnlyHint=true` → read. NUR diese Annotation kann ein Tool
 *      als read kategorisieren.
 *   5. Default: write (NICHT read). Operator-Drift in KC2 fuehrt damit zu
 *      einer ueberfluessigen Approval-Page, nicht zu einem stillen Bypass.
 *
 * Ein console.warn() macht den Drift sichtbar — der Operator soll das Tool
 * in KC2 nachannotieren.
 */
export function resolveSensitivity(
  annotations: ToolAnnotations | undefined,
  toolName?: string,
): ToolSensitivity {
  const a = (annotations ?? {}) as ToolAnnotations & {
    write?: boolean;
    sensitivity?: ToolSensitivity;
  };
  if (a.sensitivity === 'read' || a.sensitivity === 'write' || a.sensitivity === 'danger') {
    return a.sensitivity;
  }
  if (a.destructiveHint === true) return 'danger';
  if (a.write === true) return 'write';
  if (a.readOnlyHint === true) return 'read';
  // SEC-006: kein Read-Default mehr — fail-closed auf 'write'.
  if (toolName) {
    console.warn(
      `[kc_wrappers] tool "${toolName}" has no sensitivity annotation — defaulting to 'write' (SEC-006 fail-closed). ` +
        `Set annotations.sensitivity='read' on the KC2-side tool manifest if appropriate.`,
    );
  }
  return 'write';
}

function rankSensitivity(s: ToolSensitivity): number {
  if (s === 'read') return 0;
  if (s === 'write') return 1;
  return 2; // danger
}

function isObjectRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export { fetchKcManifest } from './manifest-client.js';
export type { KcManifest, KcToolManifestEntry } from './manifest-client.js';
export { forwardToKc } from './forward.js';
