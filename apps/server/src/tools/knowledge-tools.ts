/**
 * Knowledge-Tools — Docs/Skills/Search ueber KnowledgeService.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2.1 (Storage-Boundary), §7,
 * §11 Burst 3 (Tool-Surface).
 *
 * Alle Tools forwarden an `KnowledgeService` (= Wrapper um den Storage-Service
 * mcp-knowledge2). Multi-User-Schutz: jeder Call uebergibt `ctx.userId`, der
 * Service signt JWTs mit sub=userId → mcp-knowledge2 RLS filtert.
 *
 * Tool-Inventar:
 *   - knowledge.docs.create  (write, Approval-required)
 *   - knowledge.docs.read    (read)
 *   - knowledge.docs.list    (read)
 *   - knowledge.skills.list  (read)
 *   - knowledge.search       (read)
 */
import type {
  KnowledgeObject,
  ObjectsList,
  SearchHit,
} from '@mcp-approval2/adapters';
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';
import type { KnowledgeService } from '../services/knowledge.js';
import {
  KnowledgeDocsCreateInput,
  KnowledgeDocsListInput,
  KnowledgeDocsReadInput,
  KnowledgeSearchInput,
  KnowledgeSkillsListInput,
  type KnowledgeDocsCreateInput as KnowledgeDocsCreateInputT,
  type KnowledgeDocsListInput as KnowledgeDocsListInputT,
  type KnowledgeDocsReadInput as KnowledgeDocsReadInputT,
  type KnowledgeSearchInput as KnowledgeSearchInputT,
  type KnowledgeSkillsListInput as KnowledgeSkillsListInputT,
} from './types.js';

export interface KnowledgeToolsDeps {
  readonly knowledge: KnowledgeService;
}

// ---------------------------------------------------------------------------
// knowledge.docs.create — write
// ---------------------------------------------------------------------------

export function makeKnowledgeDocsCreateTool(
  deps: KnowledgeToolsDeps,
): Tool<KnowledgeDocsCreateInputT, KnowledgeObject> {
  return {
    name: 'knowledge.docs.create',
    description:
      'Create a new document (kind=doc) in the knowledge store. Requires approval.',
    sensitivity: 'write',
    displayTemplate:
      'Create new document: {{title}} ({{body.length}} chars)',
    inputSchema: KnowledgeDocsCreateInput,
    async execute(ctx: ToolContext, input): Promise<KnowledgeObject> {
      // exactOptionalPropertyTypes: nur definierte Felder weitergeben.
      const args: Parameters<KnowledgeService['createObject']>[0] = {
        userId: ctx.userId,
        kind: 'doc',
        title: input.title,
        body: input.body,
      };
      if (input.description !== undefined) {
        (args as { description?: string }).description = input.description;
      }
      if (input.keywords !== undefined) {
        (args as { keywords?: ReadonlyArray<string> }).keywords = input.keywords;
      }
      if (input.subtype !== undefined) {
        (args as { subtype?: string }).subtype = input.subtype;
      }
      if (input.visibility !== undefined) {
        (args as { visibility?: 'private' | 'shared' }).visibility = input.visibility;
      }
      return deps.knowledge.createObject(args);
    },
  };
}

// ---------------------------------------------------------------------------
// knowledge.docs.read — read
// ---------------------------------------------------------------------------

export function makeKnowledgeDocsReadTool(
  deps: KnowledgeToolsDeps,
): Tool<KnowledgeDocsReadInputT, KnowledgeObject> {
  return {
    name: 'knowledge.docs.read',
    description: 'Fetch a single document by id.',
    sensitivity: 'read',
    inputSchema: KnowledgeDocsReadInput,
    async execute(ctx: ToolContext, input): Promise<KnowledgeObject> {
      return deps.knowledge.getObject({ id: input.id, userId: ctx.userId });
    },
  };
}

// ---------------------------------------------------------------------------
// knowledge.docs.list — read
// ---------------------------------------------------------------------------

export function makeKnowledgeDocsListTool(
  deps: KnowledgeToolsDeps,
): Tool<KnowledgeDocsListInputT, ObjectsList> {
  return {
    name: 'knowledge.docs.list',
    description: "List the current user's documents.",
    sensitivity: 'read',
    inputSchema: KnowledgeDocsListInput,
    async execute(ctx: ToolContext, input): Promise<ObjectsList> {
      const args: Parameters<KnowledgeService['listObjects']>[0] = {
        userId: ctx.userId,
        kind: 'doc',
      };
      if (input.limit !== undefined) {
        (args as { limit?: number }).limit = input.limit;
      }
      if (input.cursor !== undefined) {
        (args as { cursor?: number }).cursor = input.cursor;
      }
      return deps.knowledge.listObjects(args);
    },
  };
}

// ---------------------------------------------------------------------------
// knowledge.skills.list — read
// ---------------------------------------------------------------------------

export function makeKnowledgeSkillsListTool(
  deps: KnowledgeToolsDeps,
): Tool<KnowledgeSkillsListInputT, ObjectsList> {
  return {
    name: 'knowledge.skills.list',
    description: 'List skills accessible to the current user.',
    sensitivity: 'read',
    inputSchema: KnowledgeSkillsListInput,
    async execute(ctx: ToolContext, input): Promise<ObjectsList> {
      const args: Parameters<KnowledgeService['listObjects']>[0] = {
        userId: ctx.userId,
        kind: 'skill',
      };
      if (input.limit !== undefined) {
        (args as { limit?: number }).limit = input.limit;
      }
      if (input.cursor !== undefined) {
        (args as { cursor?: number }).cursor = input.cursor;
      }
      return deps.knowledge.listObjects(args);
    },
  };
}

// ---------------------------------------------------------------------------
// knowledge.search — read (Hybrid Search over kinds)
// ---------------------------------------------------------------------------

export function makeKnowledgeSearchTool(
  deps: KnowledgeToolsDeps,
): Tool<KnowledgeSearchInputT, { hits: ReadonlyArray<SearchHit> }> {
  return {
    name: 'knowledge.search',
    description:
      'Hybrid search across objects (docs, skills, apps, memos). Returns ranked hits.',
    sensitivity: 'read',
    inputSchema: KnowledgeSearchInput,
    async execute(ctx: ToolContext, input): Promise<{ hits: ReadonlyArray<SearchHit> }> {
      const args: Parameters<KnowledgeService['search']>[0] = {
        userId: ctx.userId,
        query: input.query,
      };
      if (input.kinds !== undefined) {
        (args as { kinds?: ReadonlyArray<'doc' | 'skill' | 'app' | 'memo'> }).kinds =
          input.kinds;
      }
      if (input.limit !== undefined) {
        (args as { limit?: number }).limit = input.limit;
      }
      const hits = await deps.knowledge.search(args);
      return { hits };
    },
  };
}
