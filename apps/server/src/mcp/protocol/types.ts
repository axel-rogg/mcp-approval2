/**
 * MCP Spec Types.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2 (Architektur-Uebersicht), §11 Phase 4
 * (MCP-Protocol + Tool-Surface).
 *
 * Implementiert das Mindest-Set des Modelcontextprotocol Spec
 * (Revision 2025-11-01, Streamable-HTTP-Transport). Wire-Format ist
 * JSON-RPC 2.0. Wir definieren die Spec-Types lokal — keine offizielle
 * `@modelcontextprotocol/sdk`-Abhaengigkeit, weil wir sowohl Hono-Adapter
 * (Server) als auch Worker-Adapter (CF) sauber portabel halten muessen.
 */

// ============================================================================
// JSON-RPC 2.0 Wire-Format
// ============================================================================

export const JSON_RPC_VERSION = '2.0' as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest<P = unknown> {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: P;
}

export interface JsonRpcNotification<P = unknown> {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly method: string;
  readonly params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: JsonRpcId;
  readonly result: R;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcError {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: JsonRpcId;
  readonly error: JsonRpcErrorObject;
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcError;

/**
 * JSON-RPC 2.0 Standard Error-Codes plus MCP-spezifische Codes.
 * Spec: https://www.jsonrpc.org/specification#error_object
 */
export const JsonRpcErrorCode = {
  // JSON-RPC 2.0 spec
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // MCP/Application range: -32000 .. -32099
  Unauthorized: -32001,
  Forbidden: -32002,
  ToolNotFound: -32010,
  ToolExecutionError: -32011,
  ApprovalRequired: -32020,
  ApprovalDenied: -32021,
  IpiBlocked: -32030,
  ResourceNotFound: -32040,
} as const;

export type JsonRpcErrorCodeValue =
  (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode];

// ============================================================================
// MCP Spec — Initialize
// ============================================================================

export const MCP_PROTOCOL_VERSION = '2025-11-01' as const;

export interface ClientCapabilities {
  readonly experimental?: Record<string, unknown>;
  readonly roots?: { listChanged?: boolean };
  readonly sampling?: Record<string, unknown>;
}

export interface ServerCapabilities {
  readonly tools?: { listChanged?: boolean };
  readonly resources?: { subscribe?: boolean; listChanged?: boolean };
  readonly prompts?: { listChanged?: boolean };
  readonly logging?: Record<string, unknown>;
  readonly experimental?: Record<string, unknown>;
}

export interface ImplementationInfo {
  readonly name: string;
  readonly version: string;
}

export interface InitializeParams {
  readonly protocolVersion: string;
  readonly capabilities: ClientCapabilities;
  readonly clientInfo: ImplementationInfo;
}

export interface InitializeResult {
  readonly protocolVersion: string;
  readonly capabilities: ServerCapabilities;
  readonly serverInfo: ImplementationInfo;
  readonly instructions?: string;
}

// ============================================================================
// MCP Spec — Tools
// ============================================================================

/**
 * JSON-Schema (Draft 2020-12 Subset) — was wir aus den Zod-Schemas
 * generieren. Eigene Definition statt `json-schema`-Package fuer
 * Dependency-Slim.
 */
export interface JsonSchema {
  readonly type?: string | string[];
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: string[];
  readonly items?: JsonSchema | JsonSchema[];
  readonly enum?: unknown[];
  readonly const?: unknown;
  readonly description?: string;
  readonly default?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
  readonly oneOf?: JsonSchema[];
  readonly anyOf?: JsonSchema[];
  readonly allOf?: JsonSchema[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly $schema?: string;
  readonly title?: string;
  readonly nullable?: boolean;
}

export interface ToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
  /** WYSIWYS-spezifisch — String-Template mit `{{var}}`-Placeholdern. */
  readonly displayTemplate?: string;
  /** Sensitivity-Level fuer Approval-Gate-Routing. */
  readonly sensitivity?: 'read' | 'write' | 'danger';
}

export interface ToolMetadata {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations?: ToolAnnotations;
}

export interface ToolsListResult {
  readonly tools: ToolMetadata[];
  readonly nextCursor?: string;
}

export interface ToolsCallParams {
  readonly name: string;
  readonly arguments?: Record<string, unknown>;
}

export interface ToolResultContent {
  readonly type: 'text' | 'image' | 'resource';
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
  readonly resource?: { uri: string; mimeType?: string; text?: string };
}

export interface ToolsCallResult {
  readonly content: ToolResultContent[];
  readonly isError?: boolean;
  readonly _meta?: Record<string, unknown>;
}

// ============================================================================
// MCP Spec — Resources (Stub in Phase 4)
// ============================================================================

export interface Resource {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface ResourcesListResult {
  readonly resources: Resource[];
  readonly nextCursor?: string;
}

export interface ResourcesReadParams {
  readonly uri: string;
}

export interface ResourceContent {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly blob?: string;
}

export interface ResourcesReadResult {
  readonly contents: ResourceContent[];
}

// ============================================================================
// Type Guards
// ============================================================================

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v['jsonrpc'] === JSON_RPC_VERSION &&
    typeof v['method'] === 'string' &&
    'id' in v
  );
}

export function isJsonRpcNotification(
  value: unknown,
): value is JsonRpcNotification {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v['jsonrpc'] === JSON_RPC_VERSION &&
    typeof v['method'] === 'string' &&
    !('id' in v)
  );
}
