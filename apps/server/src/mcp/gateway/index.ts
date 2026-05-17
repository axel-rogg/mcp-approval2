/**
 * Sub-MCP-Gateway-Barrel.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.4, §9.
 *
 * Re-exports der Bausteine:
 *   - SubMcpRegistry         — DB-backed Sub-MCP-Server-Registry.
 *   - SubMcpForwarder        — JSON-RPC-Forwarder mit Service-Bearer + user-JWT.
 *   - refreshSubMcpToolCache — Discovery-Hook (Cron-trigger).
 *   - buildForwardedToolDefs — Mapping zu ForwardedToolDef[] fuer Haupt-Registry.
 *   - subMcpDiscoverRoutes   — POST /internal/v1/sub-mcp/discover.
 *
 * Caller sind:
 *   - `routes/internal/credentials.ts`            (Inbound: Sub-MCP holt JIT-Token).
 *   - Tool-Registry-Bootstrap (Burst 3+)          (Outbound: wrapper-tools).
 *   - Cron / Admin-Trigger fuer Discovery.
 */
export {
  createSubMcpRegistry,
  hashServiceToken,
  type SubMcpRegistry,
  type SubMcpRegistryOptions,
  type RegisterSubMcpArgs,
  type ServiceTokenResolver,
} from './registry.js';

export { SubMcpForwarder, type SubMcpForwarderOptions } from './forwarder.js';

export {
  refreshSubMcpToolCache,
  refreshUserSubMcpToolCache,
  buildForwardedToolDefs,
  type RefreshToolCacheArgs,
  type UserDiscoveryArgs,
  type DiscoveryResult,
} from './discovery.js';

export {
  SubMcpError,
  SubMcpForwardError,
  SubMcpNotFoundError,
  type ForwardToolCallArgs,
  type ForwardedToolDef,
  type JsonRpcResponse,
  type SubMcpAuthConfig,
  type SubMcpAuthMode,
  type SubMcpServerConfig,
  type SubMcpToolCacheEntry,
} from './types.js';

export { subMcpDiscoverRoutes } from './routes.js';

export { signSubMcpUserJwt, type SignSubMcpUserJwtArgs } from './user_jwt.js';

export {
  makeForwardingTool,
  buildSubMcpWrapperTools,
  resolveSubMcpSensitivity,
  type MakeForwardingToolArgs,
  type BuildSubMcpWrapperToolsArgs,
  type BuildSubMcpWrapperToolsResult,
} from './wrapper_tools.js';

export {
  seedSatelliteWorkers,
  DEFAULT_SATELLITE_WORKERS,
  type SatelliteWorkerSeedEntry,
  type SeedSatelliteWorkersArgs,
  type SeedResult,
} from './seed_satellites.js';

export {
  seedOAuthCatalogServers,
  DEFAULT_OAUTH_CATALOG_SERVERS,
  type OAuthCatalogServerSeed,
  type OAuthKind,
  type SeedOAuthCatalogArgs,
  type SeedOAuthCatalogResult,
} from './seed_oauth_catalog.js';

export {
  applyGatewayDiscovery,
  SubMcpWrappersCache,
  type ApplyGatewayDiscoveryArgs,
  type ApplyGatewayDiscoveryResult,
} from './refresh.js';
