/**
 * JSON-RPC 2.0 Message-Builders + MCP-Method-Constants.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2 (Request-Lifecycle), §11 Phase 4
 * (MCP-Protocol).
 *
 * Hier sind:
 *   - Konstanten fuer die MCP-Methoden (initialize, tools/list, ...)
 *   - Builder-Funktionen fuer Success / Error-Responses
 *   - Error-Mapping: AppError → JSON-RPC-Error-Code
 *   - Parse-Helper: Input → JsonRpcRequest oder ParseError-Response
 */
import {
  JSON_RPC_VERSION,
  JsonRpcErrorCode,
  isJsonRpcRequest,
  isJsonRpcNotification,
  type JsonRpcError,
  type JsonRpcErrorObject,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccess,
  type JsonRpcNotification,
} from './types.js';
import {
  ApprovalRequiredError,
  ToolInputValidationError,
  ToolNotFoundError,
} from './tool.js';
import { HttpError } from '../../lib/errors.js';

// ============================================================================
// MCP Method Constants
// ============================================================================

export const McpMethods = {
  Initialize: 'initialize',
  Initialized: 'notifications/initialized',
  Ping: 'ping',
  ToolsList: 'tools/list',
  ToolsCall: 'tools/call',
  ResourcesList: 'resources/list',
  ResourcesRead: 'resources/read',
  Cancelled: 'notifications/cancelled',
} as const;

export type McpMethod = (typeof McpMethods)[keyof typeof McpMethods];

// ============================================================================
// Response Builders
// ============================================================================

export function success<R>(id: JsonRpcId, result: R): JsonRpcSuccess<R> {
  return { jsonrpc: JSON_RPC_VERSION, id, result };
}

export function error(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  const errObj: JsonRpcErrorObject = data !== undefined ? { code, message, data } : { code, message };
  return { jsonrpc: JSON_RPC_VERSION, id, error: errObj };
}

// ============================================================================
// Error-Mapping
// ============================================================================

/**
 * Mappt eine Exception auf einen JSON-RPC-Error. Bekannte Typen werden auf
 * MCP-spezifische Codes gemapped; Unbekanntes wird `InternalError`.
 *
 * Wichtig: wir leaken keine Stack-Traces oder DB-Internals — die `data`-
 * Felder enthalten nur public-safe Infos.
 */
export function mapErrorToJsonRpc(id: JsonRpcId, err: unknown): JsonRpcError {
  if (err instanceof ToolNotFoundError) {
    return error(id, JsonRpcErrorCode.ToolNotFound, `tool not found: ${err.toolName}`, {
      tool: err.toolName,
    });
  }
  if (err instanceof ToolInputValidationError) {
    return error(id, JsonRpcErrorCode.InvalidParams, `invalid input for tool '${err.toolName}'`, {
      tool: err.toolName,
      issues: err.issues,
    });
  }
  if (err instanceof ApprovalRequiredError) {
    return error(
      id,
      JsonRpcErrorCode.ApprovalRequired,
      `tool '${err.toolName}' requires approval`,
      {
        tool: err.toolName,
        sensitivity: err.sensitivity,
        ...(err.displayTemplate ? { displayTemplate: err.displayTemplate } : {}),
      },
    );
  }
  if (err instanceof HttpError) {
    const code =
      err.status === 401
        ? JsonRpcErrorCode.Unauthorized
        : err.status === 403
          ? JsonRpcErrorCode.Forbidden
          : err.status === 404
            ? JsonRpcErrorCode.ResourceNotFound
            : err.status === 400
              ? JsonRpcErrorCode.InvalidParams
              : JsonRpcErrorCode.InternalError;
    return error(id, code, err.message, err.details);
  }
  // Unknown error → InternalError, message dampened
  const msg = err instanceof Error ? err.message : 'internal error';
  return error(id, JsonRpcErrorCode.InternalError, msg);
}

// ============================================================================
// Parse Helper
// ============================================================================

export type ParsedIncoming =
  | { kind: 'request'; request: JsonRpcRequest }
  | { kind: 'notification'; notification: JsonRpcNotification }
  | { kind: 'parse_error'; response: JsonRpcError }
  | { kind: 'invalid_request'; response: JsonRpcError };

/**
 * Parsed einen rohen JSON-Body. Liefert entweder ein gueltiges Request /
 * Notification oder eine Error-Response mit korrektem JSON-RPC-Shape.
 *
 * Batch-Requests: wir lehnen sie explizit ab. MCP-Spec (2025-11-01) erlaubt
 * sie zwar, aber der Streamable-HTTP-Transport kombiniert sie mit
 * Server-Sent-Events fuer Multi-Response — Komplexitaet die wir in Phase 4
 * nicht brauchen (Single-Tool-Calls dominieren). Falls Bedarf entsteht,
 * upgraden wir nachtraeglich.
 */
export function parseIncoming(raw: unknown): ParsedIncoming {
  if (Array.isArray(raw)) {
    return {
      kind: 'invalid_request',
      response: error(null, JsonRpcErrorCode.InvalidRequest, 'batch requests not supported'),
    };
  }
  if (!raw || typeof raw !== 'object') {
    return {
      kind: 'parse_error',
      response: error(null, JsonRpcErrorCode.ParseError, 'invalid JSON-RPC message'),
    };
  }
  if (isJsonRpcRequest(raw)) {
    return { kind: 'request', request: raw };
  }
  if (isJsonRpcNotification(raw)) {
    return { kind: 'notification', notification: raw };
  }
  const id = ((raw as Record<string, unknown>)['id'] ?? null) as JsonRpcId;
  return {
    kind: 'invalid_request',
    response: error(id, JsonRpcErrorCode.InvalidRequest, 'malformed JSON-RPC message'),
  };
}

// ============================================================================
// Type narrowing helpers
// ============================================================================

export function isResponse(
  message: JsonRpcResponse | JsonRpcRequest | JsonRpcNotification,
): message is JsonRpcResponse {
  return 'id' in message && ('result' in message || 'error' in message);
}
