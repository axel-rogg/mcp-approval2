/**
 * Tool-Registry & Dispatcher.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2 (Request-Lifecycle Step 4-9), §11
 * Phase 4 (MCP-Protocol + Tool-Surface).
 *
 * Verantwortung:
 *   - `register(tool)` — schlaegt Doppel-Registrierung mit Error fehl
 *   - `list()` — liefert ToolMetadata[] fuer `tools/list`
 *   - `dispatch({name, input, ctx})` — orchestriert den vollen Tool-Call
 *
 * Dispatch-Pipeline (Plan §2 Request-Lifecycle):
 *   4. Tool-Lookup + Permission-Check (Step 4 — hier: lookup; Permission ist
 *      OAuth-Scope-Check, vom Caller via `ctx.role`/Scopes vorzunehmen)
 *   4a. Input-Validation (Zod-parse)
 *   5. Approval-Gate: write/danger → `ApprovalRequiredError`. Der Caller
 *      (Transport) konvertiert in JSON-RPC-Error. Die PWA pollt dann
 *      `/approvals/...` und wenn approved, der Tool-Call wird ein zweites
 *      Mal aufgerufen — diesmal mit `bypassApproval` (vom approve-Service).
 *   7. Execute
 *   8. IPI-Output-Filter
 *   9. Audit-Log emit (success/failure)
 *
 * Cross-User Security (§9 "IPI / Cross-User"): die Registry selbst kennt
 * keine Cross-User-Schutzlogik — die geht ueber `ctx.userId` an Tools, die
 * dann gegen DB-RLS filtern. Hier checken wir nur "Tool existiert + Input
 * valide".
 */
import { z } from 'zod';
import {
  type AnyTool,
  type AppliedDefaultMeta,
  type Tool,
  type ToolContext,
  type ToolSensitivity,
  ApprovalRequiredError,
  ToolInputValidationError,
  ToolNotFoundError,
  toToolMetadata,
  validateToolDefinition,
} from './tool.js';
import type {
  ToolMetadata,
  ToolResultContent,
  ToolsCallResult,
} from './types.js';
import { ipiFilter } from './ipi-filter.js';
import { wrapKcUntrusted } from './output-wrapper.js';

/**
 * Reserved by the tool-defaults resolver (Plan-Ref: PLAN-tool-defaults-v2.md
 * §10 Entscheidung ①). Tools die diese Property im inputSchema deklarieren
 * werden bei `register()` fail-CLOSED abgelehnt.
 */
const RESERVED_PROFILE_ARG_NAME = '__profile';

/**
 * Best-effort-Detection ob ein Tool-Schema eine top-level Property mit dem
 * gegebenen Namen deklariert. Funktioniert fuer Zod-Object-Schemas (native
 * Tools) und z.unknown()-Schemas (kc_wrappers, sub-mcp-wrappers — in beiden
 * Faellen ist `_def.shape` undefined und die Funktion gibt false zurueck →
 * kein false-positive Reject fuer dynamische Tools).
 */
function toolDeclaresReservedProperty(tool: AnyTool, propertyName: string): boolean {
  const schema = tool.inputSchema as unknown as {
    _def?: { shape?: () => Record<string, unknown> | undefined };
  };
  const shapeFn = schema._def?.shape;
  if (typeof shapeFn !== 'function') return false;
  try {
    const shape = shapeFn();
    return !!shape && Object.prototype.hasOwnProperty.call(shape, propertyName);
  } catch {
    return false;
  }
}

export interface DispatchArgs {
  readonly name: string;
  readonly input: unknown;
  readonly ctx: ToolContext;
  /**
   * Wird vom Approval-Service gesetzt, nachdem der User in der PWA
   * approved hat. Skipt den Approval-Gate-Check.
   */
  readonly bypassApproval?: boolean;
  /**
   * Attribution-Snapshot fuer WYSIWYS (Plan-Ref: PLAN-tool-defaults-v2.md
   * Phase A). Wird durchgereicht in `ApprovalRequiredError` damit der
   * Transport sie in pending_approvals.defaults_applied persistieren kann.
   * `[]` fuer Aufrufer ohne Tool-Defaults-Resolver.
   */
  readonly defaultsApplied?: ReadonlyArray<AppliedDefaultMeta>;
}

export interface DispatchResult {
  readonly result: ToolsCallResult;
  readonly toolName: string;
  readonly sensitivity: ToolSensitivity;
  readonly durationMs: number;
}

/**
 * Re-export von Errors fuer Caller die nicht direkt tool.ts importieren wollen.
 */
export { ApprovalRequiredError, ToolNotFoundError, ToolInputValidationError };

export interface ToolRegistryOptions {
  /**
   * Optional Hook fuer Writemode-Auto-Bypass. Wird im Approval-Gate (Step 5)
   * konsultiert: liefert `true` → Tools mit `sensitivity='write'` werden ohne
   * ApprovalRequiredError ausgefuehrt. `sensitivity='danger'` ist NIEMALS
   * bypass-bar.
   *
   * Plan-Ref: docs/plans/active/PLAN-writemode.md (Slice 5).
   *
   * Default: undefined → kein Auto-Bypass (legacy-Verhalten).
   */
  readonly writemodeChecker?: (userId: string) => Promise<boolean>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();
  private readonly writemodeChecker?: (userId: string) => Promise<boolean>;

  constructor(opts: ToolRegistryOptions = {}) {
    if (opts.writemodeChecker) {
      this.writemodeChecker = opts.writemodeChecker;
    }
  }

  /**
   * Registriere ein Tool. Wirft wenn:
   *   - Name schon belegt
   *   - Tool-Definition strukturell broken (siehe validateToolDefinition)
   *   - Tool-Schema deklariert eine reservierte Property (z.B. `__profile`,
   *     siehe PLAN-tool-defaults-v2.md §10 Entscheidung ①).
   */
  register<Input, Output>(tool: Tool<Input, Output>): void {
    validateToolDefinition(tool as AnyTool);
    if (this.tools.has(tool.name)) {
      throw new Error(`tool '${tool.name}' already registered`);
    }
    // Fail-CLOSED gegen Tools die `__profile` als Property deklarieren —
    // der Tool-Defaults-Resolver (Phase A) interpretiert `__profile` als
    // Per-Call-Profile-Override und strippt es aus den Args; ein Tool
    // mit eigenem `__profile` wuerde WYSIWYS brechen.
    if (toolDeclaresReservedProperty(tool as AnyTool, RESERVED_PROFILE_ARG_NAME)) {
      throw new Error(
        `tool '${tool.name}': inputSchema declares reserved property '${RESERVED_PROFILE_ARG_NAME}'. ` +
          `This name is reserved by the tool-defaults resolver (PLAN-tool-defaults-v2.md §10).`,
      );
    }
    this.tools.set(tool.name, tool as AnyTool);
  }

  /**
   * Entfernt ein registriertes Tool — primary fuer Tests, secondary fuer
   * Hot-Reload. Production nutzt das nicht.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  size(): number {
    return this.tools.size;
  }

  /**
   * Liefert ToolMetadata-Liste fuer `tools/list`. Sortiert alphabetisch fuer
   * deterministische Antworten (wichtig fuer Caching / Snapshot-Tests).
   */
  list(): ToolMetadata[] {
    const names = [...this.tools.keys()].sort();
    return names.map((n) => {
      const t = this.tools.get(n);
      if (!t) throw new Error(`registry race: tool '${n}' disappeared`);
      const meta = toToolMetadata(t);
      const out: ToolMetadata = meta.annotations
        ? {
            name: meta.name,
            description: meta.description,
            inputSchema: meta.inputSchema,
            annotations: meta.annotations,
          }
        : {
            name: meta.name,
            description: meta.description,
            inputSchema: meta.inputSchema,
          };
      return out;
    });
  }

  /**
   * Full Dispatch-Pipeline. Wirf:
   *   - `ToolNotFoundError`        — Tool nicht registriert
   *   - `ToolInputValidationError` — Zod-Validation fail
   *   - `ApprovalRequiredError`    — sensitivity != 'read' und !bypassApproval
   *   - andere Errors aus tool.execute werden hochgereicht; Caller wickelt
   *     sie in JSON-RPC-Errors via `mapErrorToJsonRpc`.
   */
  async dispatch(args: DispatchArgs): Promise<DispatchResult> {
    const { name, input, ctx, bypassApproval, defaultsApplied } = args;
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolNotFoundError(name);
    }

    // Step 4a: Input-Validation
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({
        path: i.path.map((p) => String(p)),
        message: i.message,
      }));
      throw new ToolInputValidationError(name, issues);
    }

    // Step 5: Approval-Gate (mit optional Writemode-Auto-Bypass).
    //
    // Plan-Ref: docs/plans/active/PLAN-writemode.md.
    //
    // Schema:
    //   read   → kein Gate
    //   write  → gated, ausser bypassApproval (=approve-resume) ODER
    //            writemodeChecker(userId) liefert true.
    //   danger → gated, ausser bypassApproval. Writemode bypassen DANGER nicht.
    let writemodeBypassed = false;
    if (tool.sensitivity !== 'read' && !bypassApproval) {
      if (tool.sensitivity === 'write' && this.writemodeChecker) {
        try {
          writemodeBypassed = await this.writemodeChecker(ctx.userId);
        } catch {
          // Auto-Bypass-Lookup-Fehler → fail-closed (approval-pflichtig).
          writemodeBypassed = false;
        }
      }
      if (!writemodeBypassed) {
        throw new ApprovalRequiredError(
          name,
          tool.sensitivity,
          parsed.data,
          tool.displayTemplate,
          defaultsApplied,
        );
      }
    }

    // Step 7: Execute
    const startedAt = Date.now();
    let rawResult: unknown;
    try {
      rawResult = await tool.execute(ctx, parsed.data);
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      // Audit failure
      await safeEmitAudit(ctx, {
        action: 'tool.invoke.failure',
        toolName: name,
        sensitivity: tool.sensitivity,
        durationMs,
        error: err instanceof Error ? err.message : 'unknown',
      });
      throw err;
    }
    const durationMs = Date.now() - startedAt;

    // Step 8: IPI-Output-Wrap → Normalize → IPI-Filter.
    //
    // 8a) wrapKcUntrusted walks the raw result and tags every User-Content
    //     field (title/description/summary/body) with <external-content>
    //     boundary markers. This applies BEFORE JSON-stringify so the tags
    //     end up inside the serialized text the LLM sees. Defense-in-depth
    //     vs IPI: even content below the detection threshold of ipiFilter
    //     is clearly marked as data, not instructions.
    // 8b) normalizeToolOutput lifts to ToolsCallResult wire-shape.
    // 8c) ipiFilter does pattern-based detection + sanitize for high-
    //     confidence injection attempts.
    //
    // PLAN-Ref: PLAN-document-linking.md §10.5 D3, §3.4.
    const wrapped = wrapKcUntrusted(rawResult);
    const normalized = normalizeToolOutput(wrapped);
    const { result: filtered, scan } = ipiFilter(normalized);

    // Step 9: Audit success
    await safeEmitAudit(ctx, {
      action: 'tool.invoke.success',
      toolName: name,
      sensitivity: tool.sensitivity,
      durationMs,
      ipi_confidence: scan.confidence,
      ipi_sanitized: scan.sanitized,
      ...(writemodeBypassed ? { writemode_bypassed: true } : {}),
    });

    return {
      result: filtered,
      toolName: name,
      sensitivity: tool.sensitivity,
      durationMs,
    };
  }
}

// ============================================================================
// Output-Normalisierung
// ============================================================================

/**
 * Liftet beliebigen Tool-Output auf das `ToolsCallResult`-Wire-Shape:
 *   - Wenn `{content: [...]}` schon vorhanden → durchreichen
 *   - Wenn String → 1 Text-Content-Item
 *   - Sonst → JSON-stringify, Text-Content-Item
 *
 * Tools die `ToolResultContent[]` direkt zurueckgeben (z.B. mit Image-Items
 * gemischt) → wir akzeptieren das als Top-Level-Array.
 */
function normalizeToolOutput(raw: unknown): ToolsCallResult {
  if (isToolsCallResult(raw)) {
    return raw;
  }
  if (Array.isArray(raw) && raw.every(isToolResultContent)) {
    return { content: raw as ToolResultContent[] };
  }
  if (typeof raw === 'string') {
    return { content: [{ type: 'text', text: raw }] };
  }
  // Fallback: JSON-serialize. Wir trimmen auf 64 KB damit DB / Audit nicht
  // versehentlich riesige Payloads schluckt.
  const json = safeJsonStringify(raw);
  return { content: [{ type: 'text', text: json }] };
}

function isToolsCallResult(v: unknown): v is ToolsCallResult {
  return (
    !!v &&
    typeof v === 'object' &&
    Array.isArray((v as { content?: unknown }).content)
  );
}

function isToolResultContent(v: unknown): v is ToolResultContent {
  if (!v || typeof v !== 'object') return false;
  const t = (v as { type?: unknown }).type;
  return t === 'text' || t === 'image' || t === 'resource';
}

function safeJsonStringify(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    if (typeof s !== 'string') return '[unserializable]';
    return s.length > 65536 ? `${s.slice(0, 65536)}…[truncated]` : s;
  } catch {
    return '[unserializable]';
  }
}

// ============================================================================
// Audit-Helper
// ============================================================================

async function safeEmitAudit(
  ctx: ToolContext,
  details: {
    readonly action: string;
    readonly toolName: string;
    readonly sensitivity: ToolSensitivity;
    readonly durationMs: number;
    readonly error?: string;
    readonly ipi_confidence?: number;
    readonly ipi_sanitized?: boolean;
    readonly writemode_bypassed?: boolean;
  },
): Promise<void> {
  try {
    await ctx.audit.emit({
      action: details.action,
      actorUserId: ctx.userId,
      result: details.action.endsWith('.success') ? 'success' : 'failure',
      resourceKind: 'tool',
      resourceId: details.toolName,
      requestId: ctx.requestId,
      details: {
        sensitivity: details.sensitivity,
        durationMs: details.durationMs,
        ...(details.error ? { error: details.error } : {}),
        ...(details.ipi_confidence !== undefined ? { ipi_confidence: details.ipi_confidence } : {}),
        ...(details.ipi_sanitized !== undefined ? { ipi_sanitized: details.ipi_sanitized } : {}),
        ...(details.writemode_bypassed ? { writemode_bypassed: true } : {}),
      },
    });
  } catch {
    // Audit darf den Tool-Result nicht killen.
  }
}

// ============================================================================
// Stub-Tool fuer Smoke-Tests + Phase-4-Burst-3-Skeleton
// ============================================================================

/**
 * Kleines Echo-Tool zum Smoke-Testen der Pipeline. NICHT auto-registriert —
 * Tests muessen es explizit registrieren. Burst 3 ersetzt das durch echte Tools.
 */
export const echoTool: Tool<{ message: string }, ToolResultContent[]> = {
  name: 'echo',
  description: 'Echoes the input message back. Read-only smoke-test tool.',
  inputSchema: z.object({
    message: z.string().min(1).max(1024).describe('Message to echo'),
  }),
  sensitivity: 'read',
  async execute(_ctx, input) {
    return [{ type: 'text', text: `echo: ${input.message}` }];
  },
};
