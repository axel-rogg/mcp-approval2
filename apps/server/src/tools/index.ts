/**
 * Tool-Registrierung. Zentraler Eintrittspunkt fuer alle Core-Tools.
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Burst 3/7.
 *
 * Verantwortung:
 *   - Bundles aller "make*Tool"-Factories aus den Sub-Modulen
 *   - `registerCoreTools(registry, deps)` registriert sie atomar in der
 *     ToolRegistry
 *
 * Caller (createApp) baut die `ToolDeps` aus dem ServerContext + Services
 * und ruft `registerCoreTools(registry, deps)` genau einmal beim Boot.
 *
 * Burst-7-Erweiterung: zusaetzliche optional-Dependencies (apps, prefs, push,
 * capability-search, federated-search, sub-mcp-registry) — jeweils nur
 * registrieren wenn die zugehoerige Service-Instanz vorhanden ist. So bleibt
 * der minimal-Boot (nur system.*) erhalten, wenn nur ein Subset der Services
 * verfuegbar ist.
 */
import type { Tool } from '../mcp/protocol/tool.js';
import type { ToolRegistry } from '../mcp/protocol/registry.js';
import type { AppConfig } from '../lib/config.js';
import type { DbAdapter } from '@mcp-approval2/adapters';
import type { CredentialsService } from '../services/credentials.js';
import type { KnowledgeService } from '../services/knowledge.js';
import type { PrfSessionService } from '../services/prf-session.js';
import type { AuditService } from '../mcp/protocol/tool.js';
import type { AppsService } from '../apps/api.js';
import type { PrefsService } from '../services/prefs.js';
import type { PushService } from '../services/push.js';
import type { CapabilitySearchService } from '../services/capability-search.js';
import type { FederatedSearchService } from '../services/federated-search.js';
import type { SubMcpRegistry } from '../mcp/gateway/index.js';
import {
  makeCredentialsAddTool,
  makeCredentialsDeleteTool,
  makeCredentialsListTool,
  type CredentialsToolsDeps,
} from './credentials-tools.js';
import {
  makeKnowledgeDocsCreateTool,
  makeKnowledgeDocsListTool,
  makeKnowledgeDocsReadTool,
  makeKnowledgeSearchTool,
  makeKnowledgeSkillsListTool,
  type KnowledgeToolsDeps,
} from './knowledge-tools.js';
import {
  makeSystemEchoTool,
  makeSystemHealthTool,
} from './system-tools.js';
import {
  makeUserProfileReadTool,
  makeUserProfileUpdateTool,
} from './user-tools.js';
import { registerKcWrapperTools } from './kc-wrappers-index.js';
import { makeAppsTools } from './apps-tools.js';
import {
  makePrefsGetTool,
  makePrefsSetTool,
  makePrefsRemoveTool,
} from './prefs-tools.js';
import { makeDisplayTool } from './display-tools.js';
import { makeNativeSettingsTool } from './native-settings-tools.js';
import { makeUtilNowTool, makeUtilUuidTool } from './util-tools.js';
import { makeUserGetTool, makeUserSetTool } from './user-extended-tools.js';
import { registerGatewayMgmtTools } from './gateway-mgmt-tools.js';
import { makeCapabilitySearchTool } from './capability-search-tool.js';
import { makeFederatedSearchTool } from './federated-search-tool.js';

export interface ToolDeps {
  readonly knowledge: KnowledgeService;
  readonly credentials: CredentialsService;
  readonly prfSessions: PrfSessionService;
  readonly audit: AuditService;
  // Burst-7 optional deps
  readonly apps?: AppsService;
  readonly prefs?: PrefsService;
  readonly pushService?: PushService;
  readonly capabilitySearch?: CapabilitySearchService;
  readonly federatedSearch?: FederatedSearchService;
  readonly subMcpRegistry?: SubMcpRegistry;
  /**
   * Live-Refresh-Deps fuer gateway_server_rediscover. Wenn vorhanden,
   * aktualisiert das Tool auch die in-memory Registry; sonst nur DB-Cache.
   */
  readonly subMcpLiveRefresh?: {
    readonly toolRegistry: ToolRegistry;
    readonly forwarder: import('../mcp/gateway/forwarder.js').SubMcpForwarder;
    readonly config: Pick<AppConfig, 'JWT_SECRET' | 'JWT_ISSUER'>;
    readonly cache: import('../mcp/gateway/refresh.js').SubMcpWrappersCache;
  };
  readonly config?: AppConfig;
  readonly db?: DbAdapter;
}

export function registerCoreTools(registry: ToolRegistry, deps: ToolDeps): void {
  const credDeps: CredentialsToolsDeps = {
    credentials: deps.credentials,
    prfSessions: deps.prfSessions,
  };
  const knowledgeDeps: KnowledgeToolsDeps = { knowledge: deps.knowledge };

  // System
  registry.register(makeSystemHealthTool());
  registry.register(makeSystemEchoTool());

  // User (canonical + extended DTO)
  registry.register(makeUserProfileReadTool());
  registry.register(makeUserProfileUpdateTool());
  registry.register(makeUserGetTool());
  registry.register(makeUserSetTool());

  // Knowledge (canonical helpers — kept for back-compat with prior tools/list)
  registry.register(makeKnowledgeDocsCreateTool(knowledgeDeps));
  registry.register(makeKnowledgeDocsReadTool(knowledgeDeps));
  registry.register(makeKnowledgeDocsListTool(knowledgeDeps));
  registry.register(makeKnowledgeSkillsListTool(knowledgeDeps));
  registry.register(makeKnowledgeSearchTool(knowledgeDeps));

  // KC-Wrappers (docs.*, skills.*, memorize.*, objects.*)
  registerKcWrapperTools(registry, { knowledge: deps.knowledge });

  // Credentials
  registry.register(makeCredentialsListTool(credDeps));
  registry.register(makeCredentialsAddTool(credDeps));
  registry.register(makeCredentialsDeleteTool(credDeps));

  // Util-Helpers (always available — no extra deps required)
  registry.register(makeUtilNowTool());
  registry.register(makeUtilUuidTool());

  // Display + Native-Settings — require config injection for the latter.
  registry.register(makeDisplayTool());
  if (deps.config) {
    registry.register(makeNativeSettingsTool({ config: deps.config }));
  }

  // Apps (8 Tools) — only if AppsService is wired.
  if (deps.apps) {
    for (const tool of makeAppsTools({ apps: deps.apps })) {
      registry.register(tool);
    }
  }

  // Prefs (3 Tools) — only if PrefsService is wired.
  if (deps.prefs) {
    registry.register(makePrefsGetTool({ prefs: deps.prefs }));
    registry.register(makePrefsSetTool({ prefs: deps.prefs }));
    registry.register(makePrefsRemoveTool({ prefs: deps.prefs }));
  }

  // Capability-Search (1 Tool) — RRF over tools + skills.
  if (deps.capabilitySearch) {
    registry.register(
      makeCapabilitySearchTool({ capabilitySearch: deps.capabilitySearch }) as Tool<unknown, unknown>,
    );
  }

  // Federated-Search (1 Tool) — over all kinds via KC.
  if (deps.federatedSearch) {
    registry.register(
      makeFederatedSearchTool({ federatedSearch: deps.federatedSearch }) as Tool<unknown, unknown>,
    );
  }

  // Gateway-Mgmt (11 Tools) — only if SubMcpRegistry + db are wired.
  if (deps.subMcpRegistry && deps.db) {
    registerGatewayMgmtTools(registry, {
      registry: deps.subMcpRegistry,
      db: deps.db,
      ...(deps.subMcpLiveRefresh ? { liveRefresh: deps.subMcpLiveRefresh } : {}),
    });
  }
}

// Re-exports for tests / consumers.
export {
  makeCredentialsAddTool,
  makeCredentialsDeleteTool,
  makeCredentialsListTool,
} from './credentials-tools.js';
export {
  makeKnowledgeDocsCreateTool,
  makeKnowledgeDocsListTool,
  makeKnowledgeDocsReadTool,
  makeKnowledgeSearchTool,
  makeKnowledgeSkillsListTool,
} from './knowledge-tools.js';
export {
  makeSystemEchoTool,
  makeSystemHealthTool,
} from './system-tools.js';
export {
  makeUserProfileReadTool,
  makeUserProfileUpdateTool,
} from './user-tools.js';
export { registerKcWrapperTools } from './kc-wrappers-index.js';
export { makeAppsTools } from './apps-tools.js';
export {
  makePrefsGetTool,
  makePrefsSetTool,
  makePrefsRemoveTool,
} from './prefs-tools.js';
export { makeDisplayTool } from './display-tools.js';
export { makeNativeSettingsTool } from './native-settings-tools.js';
export { makeUtilNowTool, makeUtilUuidTool } from './util-tools.js';
export { makeUserGetTool, makeUserSetTool } from './user-extended-tools.js';
export { registerGatewayMgmtTools } from './gateway-mgmt-tools.js';
export { makeCapabilitySearchTool } from './capability-search-tool.js';
export { makeFederatedSearchTool } from './federated-search-tool.js';
export type { CredentialsToolsDeps } from './credentials-tools.js';
export type { KnowledgeToolsDeps } from './knowledge-tools.js';
export type { AppsToolsDeps } from './apps-tools.js';
export type { PrefsToolsDeps } from './prefs-tools.js';
