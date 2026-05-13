/**
 * Tool-Definition Interface.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2 (Request-Lifecycle Step 4-9), §11
 * Phase 4 (MCP-Protocol + Tool-Surface).
 *
 * Tools werden in der ToolRegistry registriert (siehe [./registry.ts]). Jeder
 * Tool-Eintrag traegt:
 *   - JSON-RPC-Identifikation (name, description)
 *   - Zod-Input-Schema (sowohl fuer Runtime-Validation als auch JSON-Schema-
 *     Generation fuer tools/list)
 *   - sensitivity (read | write | danger) — `read` ist ohne Approval ausfuehrbar,
 *     alles andere geht durch Approval-Gate (siehe registry.ts)
 *   - displayTemplate fuer WYSIWYS-Anzeige in PWA (Step 5 im Request-Lifecycle)
 *   - requiredScopes (OAuth-Token-Scopes vom Resource-Server)
 *   - execute-Funktion mit ToolContext
 *
 * Phase 4 registriert noch keine Tools — das ist Burst 3. Hier nur das Interface.
 */
import type { z } from 'zod';
import type { DbAdapter } from '@mcp-approval2/adapters';
import type { JsonSchema, ToolAnnotations, ToolResultContent } from './types.js';
import { zodToJsonSchema } from './json-schema.js';

/**
 * Sensitivity-Klassifikation. Steuert das Approval-Routing.
 *
 *   read   — keine Approval noetig, kein State-modify
 *   write  — Approval noetig (User klickt OK in PWA mit WYSIWYS-Display)
 *   danger — Approval noetig + spezielles Warning-UI in PWA + ggf. zusaetzliches
 *            Re-Auth (PRF-Eval, siehe PLAN §5.3)
 */
export type ToolSensitivity = 'read' | 'write' | 'danger';

/**
 * Audit-Service-Interface (forward-decl).
 *
 * Wir definieren das hier minimal, damit der ToolContext nicht zirkulaer auf
 * `services/audit.ts` referenzieren muss. Konkrete Implementierung adaptiert
 * die `emitAudit`-Funktion aus services/audit.ts in einen `AuditService`-
 * Wrapper.
 */
export interface AuditService {
  emit(event: {
    readonly action: string;
    readonly actorUserId: string | null;
    readonly result: 'success' | 'failure' | 'noop';
    readonly resourceKind?: string;
    readonly resourceId?: string;
    readonly requestId?: string;
    readonly details?: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * Pro-Request-Context, der ans Tool durchgereicht wird. Singletons (db, audit)
 * stammen aus dem ServerContext; pro-Request-Felder (userId, requestId) aus
 * der Auth-Middleware.
 *
 * Tools koennen `ctx.signal` checken fuer Cancellation (MCP `notifications/cancelled`).
 */
export interface ToolContext {
  readonly userId: string;
  readonly email: string;
  readonly role: 'admin' | 'member';
  readonly requestId: string;
  readonly audit: AuditService;
  readonly db: DbAdapter;
  /** AbortSignal — wird auf `notifications/cancelled` getriggert. */
  readonly signal: AbortSignal;
}

/**
 * Tool-Definition. Generic ueber Input/Output — bei Registrierung wird
 * der Typ aus `inputSchema` inferiert.
 */
export interface Tool<
  Input = unknown,
  Output extends ToolResultContent[] | unknown = unknown,
> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly sensitivity: ToolSensitivity;
  readonly displayTemplate?: string;
  readonly requiredScopes?: readonly string[];
  /**
   * Optional Annotations fuer MCP `tools/list`. `displayTemplate` +
   * `sensitivity` werden automatisch aus den Top-Level-Feldern uebernommen
   * wenn hier nicht gesetzt.
   */
  readonly annotations?: ToolAnnotations;
  /**
   * Output-Typ ist intentional flexibel — die Registry verpackt das Ergebnis
   * in den korrekten `ToolsCallResult`-Wire-Shape. Tools koennen plain Objects
   * zurueckgeben (werden zu JSON-text-content), oder direkt `ToolResultContent[]`.
   */
  readonly execute: (ctx: ToolContext, input: Input) => Promise<Output>;
}

/**
 * Helper: Tool-Definition aus untypisiertem Object ableiten. Akzeptiert
 * `Tool<unknown, unknown>` — fuer Registry-Storage. Tools nutzen den
 * generischen `Tool<Input, Output>` beim Definieren.
 */
export type AnyTool = Tool<unknown, unknown>;

/**
 * Validator: prueft strukturelle Pflicht-Felder. Wirft `Error` bei Verstoss.
 *
 * Pflicht: name, description, inputSchema, sensitivity, execute.
 * Naming-Konvention: lowercase + dots + underscores, kein whitespace.
 */
export function validateToolDefinition(tool: AnyTool): void {
  if (!tool.name || typeof tool.name !== 'string') {
    throw new Error('tool.name required');
  }
  if (!/^[a-z][a-z0-9_.:-]{0,79}$/.test(tool.name)) {
    throw new Error(
      `tool.name '${tool.name}' must match /^[a-z][a-z0-9_.:-]{0,79}$/`,
    );
  }
  if (!tool.description || typeof tool.description !== 'string') {
    throw new Error(`tool '${tool.name}': description required`);
  }
  if (tool.description.length > 1024) {
    throw new Error(`tool '${tool.name}': description > 1024 chars`);
  }
  if (!tool.inputSchema || typeof tool.inputSchema.parse !== 'function') {
    throw new Error(`tool '${tool.name}': inputSchema must be a Zod schema`);
  }
  const SENS: ReadonlyArray<ToolSensitivity> = ['read', 'write', 'danger'];
  if (!SENS.includes(tool.sensitivity)) {
    throw new Error(
      `tool '${tool.name}': sensitivity must be 'read' | 'write' | 'danger'`,
    );
  }
  if (typeof tool.execute !== 'function') {
    throw new Error(`tool '${tool.name}': execute must be a function`);
  }
  if (tool.displayTemplate && tool.displayTemplate.length > 2048) {
    throw new Error(`tool '${tool.name}': displayTemplate > 2048 chars`);
  }
}

/**
 * Liftet Tool → ToolMetadata fuer `tools/list`-Antworten. JSON-Schema
 * wird aus dem Zod-Schema generiert (siehe [./json-schema.ts]).
 */
export function toToolMetadata(tool: AnyTool): {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations?: ToolAnnotations;
} {
  const baseAnnotations: ToolAnnotations = {
    sensitivity: tool.sensitivity,
    readOnlyHint: tool.sensitivity === 'read',
    destructiveHint: tool.sensitivity === 'danger',
    ...(tool.displayTemplate ? { displayTemplate: tool.displayTemplate } : {}),
    ...(tool.annotations ?? {}),
  };
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.inputSchema),
    annotations: baseAnnotations,
  };
}

// ============================================================================
// Tool-Errors (re-exported via registry.ts)
// ============================================================================

export class ToolNotFoundError extends Error {
  public readonly toolName: string;
  constructor(toolName: string) {
    super(`tool '${toolName}' not found`);
    this.name = 'ToolNotFoundError';
    this.toolName = toolName;
  }
}

export class ToolInputValidationError extends Error {
  public readonly toolName: string;
  public readonly issues: ReadonlyArray<{ path: string[]; message: string }>;
  constructor(
    toolName: string,
    issues: ReadonlyArray<{ path: string[]; message: string }>,
  ) {
    super(`tool '${toolName}': input validation failed`);
    this.name = 'ToolInputValidationError';
    this.toolName = toolName;
    this.issues = issues;
  }
}

export class ApprovalRequiredError extends Error {
  public readonly toolName: string;
  public readonly sensitivity: ToolSensitivity;
  public readonly input: unknown;
  public readonly displayTemplate: string | undefined;
  constructor(
    toolName: string,
    sensitivity: ToolSensitivity,
    input: unknown,
    displayTemplate?: string,
  ) {
    super(`tool '${toolName}' requires approval (sensitivity=${sensitivity})`);
    this.name = 'ApprovalRequiredError';
    this.toolName = toolName;
    this.sensitivity = sensitivity;
    this.input = input;
    this.displayTemplate = displayTemplate;
  }
}
