/**
 * KC-Wrapper-Tools — Bundle-Registrierung.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2.1 (Storage-Boundary)
 *
 * Wrappers fuer docs.*, skills.*, memorize.*, objects.*, lists.*, notes.* —
 * alle forwarden an KnowledgeService → mcp-knowledge2 (HttpKnowledgeAdapter).
 *
 * Total: 31 Tools (7 docs + 7 skills + 4 memorize + 2 objects + 6 lists +
 *                  5 notes). bookmarks/recipes wurden 2026-05-17 entfernt
 *                  (siehe apps/server/src/_to_delete/2026-05-17/).
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
  makeSkillsDetachResourceTool,
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
import {
  makeListsAddItemTool,
  makeListsCreateTool,
  makeListsGetTool,
  makeListsListTool,
  makeListsTickTool,
  makeListsUntickTool,
  type ListsToolsDeps,
} from './lists-tools.js';
import {
  makeNotesCreateTool,
  makeNotesDeleteTool,
  makeNotesGetTool,
  makeNotesListTool,
  makeNotesUpdateTool,
  type NotesToolsDeps,
} from './notes-tools.js';
// bookmarks-tools + recipes-tools entfernt 2026-05-17 (User-Entscheidung:
// Solo-Pilot braucht keine URL-Save-Surface oder Recipe-DB; bessere Tools
// existieren extern). Soft-Delete unter apps/server/src/_to_delete/2026-05-17/.

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
  const liDeps: ListsToolsDeps = { knowledge: deps.knowledge };
  const nDeps: NotesToolsDeps = { knowledge: deps.knowledge };

  // Docs (7)
  registry.register(makeDocsPutTool(dDeps));
  registry.register(makeDocsGetTool(dDeps));
  registry.register(makeDocsListTool(dDeps));
  registry.register(makeDocsDeleteTool(dDeps));
  registry.register(makeDocsUsagesTool(dDeps));
  registry.register(makeDocsAttachToTool(dDeps));
  registry.register(makeDocsUpdateSummaryTool(dDeps));

  // Skills (8) — PLAN-doc-linking P7: detach_resource hinzugefügt.
  registry.register(makeSkillsPutTool(sDeps));
  registry.register(makeSkillsGetTool(sDeps));
  registry.register(makeSkillsListTool(sDeps));
  registry.register(makeSkillsDeleteTool(sDeps));
  registry.register(makeSkillsSearchTool(sDeps));
  registry.register(makeSkillsReadResourceTool(sDeps));
  registry.register(makeSkillsAttachResourceTool(sDeps));
  registry.register(makeSkillsDetachResourceTool(sDeps));

  // Memorize (4)
  registry.register(makeMemorizeAddTool(mDeps));
  registry.register(makeMemorizeSearchTool(mDeps));
  registry.register(makeMemorizeListRecentTool(mDeps));
  registry.register(makeMemorizeDeleteTool(mDeps));

  // Objects (2)
  registry.register(makeObjectsListTool(oDeps));
  registry.register(makeObjectsReadTool(oDeps));

  // Lists (6)
  registry.register(makeListsCreateTool(liDeps));
  registry.register(makeListsAddItemTool(liDeps));
  registry.register(makeListsTickTool(liDeps));
  registry.register(makeListsUntickTool(liDeps));
  registry.register(makeListsListTool(liDeps));
  registry.register(makeListsGetTool(liDeps));

  // Notes (5)
  registry.register(makeNotesCreateTool(nDeps));
  registry.register(makeNotesUpdateTool(nDeps));
  registry.register(makeNotesListTool(nDeps));
  registry.register(makeNotesGetTool(nDeps));
  registry.register(makeNotesDeleteTool(nDeps));

  // Bookmarks + Recipes — entfernt 2026-05-17 (siehe Header-Kommentar).
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

export {
  makeListsAddItemTool,
  makeListsCreateTool,
  makeListsGetTool,
  makeListsListTool,
  makeListsTickTool,
  makeListsUntickTool,
} from './lists-tools.js';
export type { ListsToolsDeps } from './lists-tools.js';

export {
  makeNotesCreateTool,
  makeNotesDeleteTool,
  makeNotesGetTool,
  makeNotesListTool,
  makeNotesUpdateTool,
} from './notes-tools.js';
export type { NotesToolsDeps } from './notes-tools.js';

// bookmarks-tools / recipes-tools Re-exports entfernt 2026-05-17.
