/**
 * Tool/Server-Inventory-Route — Read-only Listing fuer die PWA-Tools-View.
 *
 * Plan-Ref: PWA-Tools-Surface (analog v1-mcp-approval `#/servers`-Route).
 *
 * Liefert:
 *   - Native Tools aus der `ToolRegistry` (alphabetisch sortiert, mit
 *     Description + Sensitivity-Hint)
 *   - Sub-MCP-Gateways aus dem `SubMcpRegistry` mit deren cached `tools/list`-
 *     Output (jeder Tool-Entry: Name, Description, ggf. annotations.sensitivity)
 *
 * Auth: authenticated User reicht (kein admin-only). Die Liste enthaelt keine
 * Operator-Secrets (kein baseUrl, kein authMode, kein serviceToken). Sensitivity-
 * Hint kommt aus `annotations.sensitivity` (Default 'write' fuer Sub-MCPs ohne
 * explizite Annotation — fail-closed, SEC-006-Pattern).
 */
import { Hono } from 'hono';
import type { AppBindings, ServerContext } from '../lib/context.js';
import { auth } from '../middleware/auth.js';
import type { ToolRegistry } from '../mcp/protocol/registry.js';
import type { SubMcpRegistry } from '../mcp/gateway/registry.js';

export interface InventoryRouteDeps {
  readonly server: ServerContext;
  readonly registry: ToolRegistry;
  readonly subMcpRegistry?: SubMcpRegistry;
}

interface NativeToolEntry {
  readonly name: string;
  readonly description: string;
  readonly sensitivity: 'read' | 'write' | 'danger';
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
}

interface GatewayToolEntry {
  readonly name: string;
  readonly description: string | null;
  readonly sensitivity: 'read' | 'write' | 'danger';
}

interface GatewayEntry {
  readonly name: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly toolsCachedAt: number | null;
  readonly tools: ReadonlyArray<GatewayToolEntry>;
}

interface InventoryResponse {
  readonly native: ReadonlyArray<NativeToolEntry>;
  readonly gateways: ReadonlyArray<GatewayEntry>;
}

function sensitivityFromAnnotations(annotations: unknown): 'read' | 'write' | 'danger' {
  if (annotations && typeof annotations === 'object') {
    const a = annotations as Record<string, unknown>;
    const s = a['sensitivity'];
    if (s === 'read' || s === 'write' || s === 'danger') return s;
    if (a['readOnlyHint'] === true) return 'read';
    if (a['destructiveHint'] === true) return 'danger';
  }
  // SEC-006: fail-closed default
  return 'write';
}

function mapNative(registry: ToolRegistry): NativeToolEntry[] {
  return registry.list().map((meta) => {
    const sens = sensitivityFromAnnotations(meta.annotations);
    return {
      name: meta.name,
      description: meta.description,
      sensitivity: sens,
      readOnlyHint: sens === 'read',
      destructiveHint: sens === 'danger',
    };
  });
}

async function mapGateways(
  subMcpRegistry: SubMcpRegistry,
): Promise<GatewayEntry[]> {
  const servers = await subMcpRegistry.listAll();
  return servers.map((s) => {
    const toolsCache = s.toolsCache ?? [];
    const tools: GatewayToolEntry[] = toolsCache.map((t) => ({
      name: t.name,
      description: t.description ?? null,
      sensitivity: sensitivityFromAnnotations(t.annotations),
    }));
    // alphabetisch sortiert — analog zu native registry.list()
    tools.sort((a, b) => a.name.localeCompare(b.name));
    return {
      name: s.name,
      displayName: s.displayName,
      enabled: s.enabled,
      toolsCachedAt: s.toolsCachedAt,
      tools,
    };
  });
}

export function inventoryRoutes(deps: InventoryRouteDeps): Hono<AppBindings> {
  const { server, registry, subMcpRegistry } = deps;
  const app = new Hono<AppBindings>();
  const guard = auth(server);

  app.get('/v1/inventory', guard, async (c) => {
    const native = mapNative(registry);
    const gateways = subMcpRegistry ? await mapGateways(subMcpRegistry) : [];
    const body: InventoryResponse = { native, gateways };
    return c.json(body);
  });

  return app;
}
