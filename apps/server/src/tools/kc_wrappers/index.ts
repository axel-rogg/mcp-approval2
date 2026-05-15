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
  let sensitivity: ToolSensitivity = resolveSensitivity(annotations);
  const override = opts.sensitivityOverrides?.[entry.name];
  if (override !== undefined) {
    // Override-up only — down ablehnen.
    if (rankSensitivity(override) > rankSensitivity(sensitivity)) {
      sensitivity = override;
    }
  }

  const displayTemplate = annotations.displayTemplate;

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

function resolveSensitivity(annotations: ToolAnnotations | undefined): ToolSensitivity {
  if (!annotations) return 'read';
  const a = annotations as ToolAnnotations & { write?: boolean; sensitivity?: ToolSensitivity };
  if (a.sensitivity) return a.sensitivity;
  if (a.write === true) return 'write';
  if (a.destructiveHint === true) return 'danger';
  if (a.readOnlyHint === true) return 'read';
  return 'read';
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
