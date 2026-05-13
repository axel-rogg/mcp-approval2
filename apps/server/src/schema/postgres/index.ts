/**
 * Postgres-Schema-Barrel-File.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3, §5, §6.
 *
 * Re-exportiert alle Tabellen fuer Drizzle-Kit (drizzle.config.ts schema-Path)
 * und Application-Code. SQLite-Dialect kommt spaeter in einem eigenen Barrel
 * (./sqlite/index.ts).
 */
export { usersTable, invitesTable } from './users.js';
export { sessionsTable, refreshTokensTable, revokedJtisTable } from './sessions.js';
export { webauthnCredentialsTable } from './webauthn.js';
export { credentialsTable } from './credentials.js';
export { auditLogTable } from './audit.js';
export {
  oauthClientsTable,
  oauthAuthzCodesTable,
  oauthRefreshTokensTable,
} from './oauth.js';
export { subMcpServersTable, SUB_MCP_AUTH_MODES } from './sub-mcp.js';
export type {
  SubMcpAuthMode,
  SubMcpAuthConfig,
  SubMcpToolCacheEntry,
} from './sub-mcp.js';
