/**
 * Objects-Tools — technical, subtype-agnostic view auf den Knowledge-Store.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2.1, §7
 *
 * `objects.list` und `objects.read` sind duenne Wrapper auf KnowledgeService
 * ohne subtype-Filter (im Gegensatz zu docs/skills/memorize, die fix auf einen
 * subtype festgenagelt sind). Vorgesehen fuer die PWA-Storage-Tab und Power-User-
 * Debug-Workflows.
 *
 * Tool-Inventar:
 *   - objects.list (read)  — alle Objekte, optional subtype-Filter (free-form)
 *   - objects.read (read)  — by id, optional expand_body
 */
import type { KnowledgeObject, ObjectsList } from '@mcp-approval2/adapters';
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';
import type { KnowledgeService } from '../services/knowledge.js';
import {
  ObjectsListInput,
  ObjectsReadInput,
  type ObjectsListInput as ObjectsListInputT,
  type ObjectsReadInput as ObjectsReadInputT,
} from './types.js';

export interface ObjectsToolsDeps {
  readonly knowledge: KnowledgeService;
}

// ---------------------------------------------------------------------------
// objects.list — read (subtype-agnostic)
// ---------------------------------------------------------------------------

export function makeObjectsListTool(
  deps: ObjectsToolsDeps,
): Tool<ObjectsListInputT, ObjectsList> {
  return {
    name: 'objects.list',
    description:
      "Technical view: list the current user's objects. Optional free-form subtype filter (e.g. 'doc', 'skill_manifest', 'memo', 'app:composable').",
    sensitivity: 'read',
    inputSchema: ObjectsListInput,
    async execute(ctx: ToolContext, input): Promise<ObjectsList> {
      const args: Parameters<KnowledgeService['listObjects']>[0] = {
        userId: ctx.userId,
      };
      if (input.subtype !== undefined) {
        (args as { subtype?: string }).subtype = input.subtype;
      }
      if (input.limit !== undefined) (args as { limit?: number }).limit = input.limit;
      if (input.cursor !== undefined) (args as { cursor?: number }).cursor = input.cursor;
      return deps.knowledge.listObjects(args);
    },
  };
}

// ---------------------------------------------------------------------------
// objects.read — read (subtype-agnostic)
// ---------------------------------------------------------------------------

export function makeObjectsReadTool(
  deps: ObjectsToolsDeps,
): Tool<ObjectsReadInputT, KnowledgeObject> {
  return {
    name: 'objects.read',
    description: 'Technical view: read any object by id (subtype-agnostic). Pass expand_body=true for the body.',
    sensitivity: 'read',
    inputSchema: ObjectsReadInput,
    async execute(ctx: ToolContext, input): Promise<KnowledgeObject> {
      return deps.knowledge.getObject({ id: input.id, userId: ctx.userId });
    },
  };
}
