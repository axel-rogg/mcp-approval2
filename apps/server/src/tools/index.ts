/**
 * Tool-Registrierung. Zentraler Eintrittspunkt fuer alle Core-Tools.
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Burst 3.
 *
 * Verantwortung:
 *   - Bundles aller "make*Tool"-Factories aus den Sub-Modulen
 *   - `registerCoreTools(registry, deps)` registriert sie atomar in der
 *     ToolRegistry
 *
 * Caller (createApp) baut die `ToolDeps` aus dem ServerContext + Services
 * und ruft `registerCoreTools(registry, deps)` genau einmal beim Boot.
 */
import type { ToolRegistry } from '../mcp/protocol/registry.js';
import type { CredentialsService } from '../services/credentials.js';
import type { KnowledgeService } from '../services/knowledge.js';
import type { PrfSessionService } from '../services/prf-session.js';
import type { AuditService } from '../mcp/protocol/tool.js';
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

export interface ToolDeps {
  readonly knowledge: KnowledgeService;
  readonly credentials: CredentialsService;
  readonly prfSessions: PrfSessionService;
  readonly audit: AuditService;
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

  // User
  registry.register(makeUserProfileReadTool());
  registry.register(makeUserProfileUpdateTool());

  // Knowledge
  registry.register(makeKnowledgeDocsCreateTool(knowledgeDeps));
  registry.register(makeKnowledgeDocsReadTool(knowledgeDeps));
  registry.register(makeKnowledgeDocsListTool(knowledgeDeps));
  registry.register(makeKnowledgeSkillsListTool(knowledgeDeps));
  registry.register(makeKnowledgeSearchTool(knowledgeDeps));

  // Credentials
  registry.register(makeCredentialsListTool(credDeps));
  registry.register(makeCredentialsAddTool(credDeps));
  registry.register(makeCredentialsDeleteTool(credDeps));
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
export type { CredentialsToolsDeps } from './credentials-tools.js';
export type { KnowledgeToolsDeps } from './knowledge-tools.js';
