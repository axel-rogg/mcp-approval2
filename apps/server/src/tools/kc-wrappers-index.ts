/**
 * KC-Wrapper-Tools — Bundle-Registrierung.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2.1 (Storage-Boundary)
 *
 * Wrappers fuer docs.*, skills.*, memorize.*, objects.* — alle forwarden an
 * KnowledgeService → mcp-knowledge2 (HttpKnowledgeAdapter).
 *
 * Total: 20 Tools (7 docs + 7 skills + 4 memorize + 2 objects).
 *
 * Wird vom Caller (createApp) AUFTRAGSGEMAESS getrennt von den existierenden
 * registerCoreTools registriert. Hot-Path: registerKcWrapperTools(registry, {knowledge}).
 */
import type { ToolRegistry } from '../mcp/protocol/registry.js';
import type { AuditService } from '../mcp/protocol/tool.js';
import type { KnowledgeService } from '../services/knowledge.js';
import {
  makeDocsAttachToTool,
  makeDocsDeleteTool,
  makeDocsGetTool,
  makeDocsListTool,
  makeDocsPutTool,
  makeDocsUpdateSummaryTool,
  makeDocsUsagesTool,
  type DocsToolsDeps,
} from './docs-tools.js';
import {
  makeSkillsAttachResourceTool,
  makeSkillsDeleteTool,
  makeSkillsGetTool,
  makeSkillsListTool,
  makeSkillsPutTool,
  makeSkillsReadResourceTool,
  makeSkillsSearchTool,
  type SkillsToolsDeps,
} from './skills-tools.js';
import {
  makeMemorizeAddTool,
  makeMemorizeDeleteTool,
  makeMemorizeListRecentTool,
  makeMemorizeSearchTool,
  type MemorizeToolsDeps,
} from './memorize-tools.js';
import {
  makeObjectsListTool,
  makeObjectsReadTool,
  type ObjectsToolsDeps,
} from './objects-tools.js';

export interface KcWrapperDeps {
  readonly knowledge: KnowledgeService;
  readonly audit?: AuditService;
}

/**
 * Registriere alle KC-Wrapper-Tools auf die uebergebene Registry.
 *
 * Duplicate-Schutz: Die Registry wirft, wenn ein Name kollidiert. Wenn der
 * Caller versehentlich beides — `registerCoreTools` und `registerKcWrapperTools`
 * — mit ueberlappendem Namespace registriert, schlaegt der zweite Aufruf
 * fail-fast. Heute keine Ueberlappung (Core-Tools nutzen `knowledge.*` Prefix,
 * Wrapper nutzen `docs.*`/`skills.*`/`memorize.*`/`objects.*`).
 */
export function registerKcWrapperTools(
  registry: ToolRegistry,
  deps: KcWrapperDeps,
): void {
  const dDeps: DocsToolsDeps = { knowledge: deps.knowledge };
  const sDeps: SkillsToolsDeps = { knowledge: deps.knowledge };
  const mDeps: MemorizeToolsDeps = { knowledge: deps.knowledge };
  const oDeps: ObjectsToolsDeps = { knowledge: deps.knowledge };

  // Docs (7)
  registry.register(makeDocsPutTool(dDeps));
  registry.register(makeDocsGetTool(dDeps));
  registry.register(makeDocsListTool(dDeps));
  registry.register(makeDocsDeleteTool(dDeps));
  registry.register(makeDocsUsagesTool(dDeps));
  registry.register(makeDocsAttachToTool(dDeps));
  registry.register(makeDocsUpdateSummaryTool(dDeps));

  // Skills (7)
  registry.register(makeSkillsPutTool(sDeps));
  registry.register(makeSkillsGetTool(sDeps));
  registry.register(makeSkillsListTool(sDeps));
  registry.register(makeSkillsDeleteTool(sDeps));
  registry.register(makeSkillsSearchTool(sDeps));
  registry.register(makeSkillsReadResourceTool(sDeps));
  registry.register(makeSkillsAttachResourceTool(sDeps));

  // Memorize (4)
  registry.register(makeMemorizeAddTool(mDeps));
  registry.register(makeMemorizeSearchTool(mDeps));
  registry.register(makeMemorizeListRecentTool(mDeps));
  registry.register(makeMemorizeDeleteTool(mDeps));

  // Objects (2)
  registry.register(makeObjectsListTool(oDeps));
  registry.register(makeObjectsReadTool(oDeps));
}

// ---------------------------------------------------------------------------
// Re-exports for tests & consumers
// ---------------------------------------------------------------------------

export {
  makeDocsAttachToTool,
  makeDocsDeleteTool,
  makeDocsGetTool,
  makeDocsListTool,
  makeDocsPutTool,
  makeDocsUpdateSummaryTool,
  makeDocsUsagesTool,
} from './docs-tools.js';
export type { DocsToolsDeps } from './docs-tools.js';

export {
  makeSkillsAttachResourceTool,
  makeSkillsDeleteTool,
  makeSkillsGetTool,
  makeSkillsListTool,
  makeSkillsPutTool,
  makeSkillsReadResourceTool,
  makeSkillsSearchTool,
} from './skills-tools.js';
export type { SkillsToolsDeps } from './skills-tools.js';

export {
  makeMemorizeAddTool,
  makeMemorizeDeleteTool,
  makeMemorizeListRecentTool,
  makeMemorizeSearchTool,
} from './memorize-tools.js';
export type { MemorizeToolsDeps } from './memorize-tools.js';

export {
  makeObjectsListTool,
  makeObjectsReadTool,
} from './objects-tools.js';
export type { ObjectsToolsDeps } from './objects-tools.js';
