/**
 * MCP-Protocol — Hono-Router-Factory + Re-Exports.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2 (Architektur), §11 Phase 4.
 *
 * Konsumiert wird das aus `apps/server/src/index.ts` via:
 *
 *   import { mcpProtocolRoutes, ToolRegistry } from './mcp/protocol/index.js';
 *   const registry = new ToolRegistry();
 *   // ... Tools registrieren ...
 *   app.route('/', mcpProtocolRoutes({ server, registry }));
 *
 * Die Mount-Verkabelung in `apps/server/src/index.ts` bleibt Burst-3-Aufgabe
 * (wir wollen nicht mit dem parallelen OAuth-Subagent kollidieren). Hier
 * stellen wir nur die Factory bereit.
 */
import { Hono } from 'hono';
import type { AppBindings } from '../../lib/context.js';
import { mcpTransport, type McpTransportOptions } from './transport.js';

export function mcpProtocolRoutes(opts: McpTransportOptions): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route('/', mcpTransport(opts));
  return app;
}

// Re-exports — Caller (Tool-Definers, Tests) importieren via `./mcp/protocol`.
export { ToolRegistry, echoTool } from './registry.js';
export type { DispatchArgs, DispatchResult } from './registry.js';
export {
  validateToolDefinition,
  toToolMetadata,
  ApprovalRequiredError,
  ToolInputValidationError,
  ToolNotFoundError,
} from './tool.js';
export type {
  AnyTool,
  AuditService,
  Tool,
  ToolContext,
  ToolSensitivity,
} from './tool.js';
export { zodToJsonSchema } from './json-schema.js';
export { ipiFilter, scanText, normalizeText } from './ipi-filter.js';
export type { IpiScanResult, SanitizedToolResult } from './ipi-filter.js';
export { wrapKcUntrusted } from './output-wrapper.js';
export {
  McpMethods,
  mapErrorToJsonRpc,
  parseIncoming,
  success as rpcSuccess,
  error as rpcError,
} from './messages.js';
export type { McpMethod, ParsedIncoming } from './messages.js';
export {
  JSON_RPC_VERSION,
  JsonRpcErrorCode,
  MCP_PROTOCOL_VERSION,
} from './types.js';
export type {
  ClientCapabilities,
  ImplementationInfo,
  InitializeParams,
  InitializeResult,
  JsonRpcError,
  JsonRpcErrorObject,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
  JsonSchema,
  Resource,
  ResourceContent,
  ResourcesListResult,
  ResourcesReadParams,
  ResourcesReadResult,
  ServerCapabilities,
  ToolAnnotations,
  ToolMetadata,
  ToolResultContent,
  ToolsCallParams,
  ToolsCallResult,
  ToolsListResult,
} from './types.js';
