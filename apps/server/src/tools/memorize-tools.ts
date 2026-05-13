/**
 * Memorize-Tools — KC-Wrapper fuer kind='memo' Objekte.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2.1, §7 (atomare Fakten / semantic recall)
 *
 * Memos sind kurze atomare Fakten (≤ 2000 chars), gespeichert als kind='memo'
 * mit subtype=scope. Vectorize triggert ueber `embed=true` beim create. Search
 * ist semantic (vector-only); list_recent ist chronological.
 *
 * Tool-Inventar:
 *   - memorize.add         (write)
 *   - memorize.search      (read)
 *   - memorize.list_recent (read)
 *   - memorize.delete      (danger)
 */
import type {
  CreateObjectArgs,
  KnowledgeObject,
  ObjectsList,
  SearchHit,
} from '@mcp-approval2/adapters';
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';
import type { KnowledgeService } from '../services/knowledge.js';
import {
  MemorizeAddInput,
  MemorizeDeleteInput,
  MemorizeListRecentInput,
  MemorizeSearchInput,
  type MemorizeAddInput as MemorizeAddInputT,
  type MemorizeDeleteInput as MemorizeDeleteInputT,
  type MemorizeListRecentInput as MemorizeListRecentInputT,
  type MemorizeSearchInput as MemorizeSearchInputT,
} from './types.js';

export interface MemorizeToolsDeps {
  readonly knowledge: KnowledgeService;
}

// ---------------------------------------------------------------------------
// memorize.add — write
// ---------------------------------------------------------------------------

export function makeMemorizeAddTool(
  deps: MemorizeToolsDeps,
): Tool<MemorizeAddInputT, KnowledgeObject> {
  return {
    name: 'memorize.add',
    description:
      'Add an atomic memo fact for semantic recall ("what do I know about X"). Triggers embedding.',
    sensitivity: 'write',
    displayTemplate: 'Memorize: "{{text}}"',
    inputSchema: MemorizeAddInput,
    async execute(ctx: ToolContext, input): Promise<KnowledgeObject> {
      const args: CreateObjectArgs = {
        userId: ctx.userId,
        kind: 'memo',
        subtype: input.scope,
        title: input.text.slice(0, 200),
        body: input.text,
        embed: true,
      };
      if (input.keywords !== undefined) {
        (args as { keywords?: ReadonlyArray<string> }).keywords = input.keywords;
      }
      return deps.knowledge.createObject(args);
    },
  };
}

// ---------------------------------------------------------------------------
// memorize.search — read (semantic recall)
// ---------------------------------------------------------------------------

export function makeMemorizeSearchTool(
  deps: MemorizeToolsDeps,
): Tool<MemorizeSearchInputT, { hits: ReadonlyArray<SearchHit> }> {
  return {
    name: 'memorize.search',
    description:
      'Semantic recall over memos. Returns time-decayed score hits restricted to kind=memo. Optional scope filter post-fetch.',
    sensitivity: 'read',
    inputSchema: MemorizeSearchInput,
    async execute(ctx: ToolContext, input): Promise<{ hits: ReadonlyArray<SearchHit> }> {
      const args: Parameters<KnowledgeService['search']>[0] = {
        userId: ctx.userId,
        query: input.query,
        kinds: ['memo'],
      };
      if (input.limit !== undefined) (args as { limit?: number }).limit = input.limit;
      const hits = await deps.knowledge.search(args);
      // Scope filter applied client-side (server doesn't filter by subtype in search).
      if (input.scope === undefined) return { hits };
      const target = input.scope;
      return { hits: hits.filter((h) => h.subtype === target) };
    },
  };
}

// ---------------------------------------------------------------------------
// memorize.list_recent — read (chronological)
// ---------------------------------------------------------------------------

export function makeMemorizeListRecentTool(
  deps: MemorizeToolsDeps,
): Tool<MemorizeListRecentInputT, ObjectsList> {
  return {
    name: 'memorize.list_recent',
    description: 'List recent memos in chronological order. Optional filter by scope.',
    sensitivity: 'read',
    inputSchema: MemorizeListRecentInput,
    async execute(ctx: ToolContext, input): Promise<ObjectsList> {
      const args: Parameters<KnowledgeService['listObjects']>[0] = {
        userId: ctx.userId,
        kind: 'memo',
      };
      if (input.scope !== undefined) (args as { subtype?: string }).subtype = input.scope;
      if (input.limit !== undefined) (args as { limit?: number }).limit = input.limit;
      if (input.cursor !== undefined) (args as { cursor?: number }).cursor = input.cursor;
      return deps.knowledge.listObjects(args);
    },
  };
}

// ---------------------------------------------------------------------------
// memorize.delete — danger
// ---------------------------------------------------------------------------

export function makeMemorizeDeleteTool(
  deps: MemorizeToolsDeps,
): Tool<MemorizeDeleteInputT, { deleted: true; id: string }> {
  return {
    name: 'memorize.delete',
    description: 'Delete a memo by id.',
    sensitivity: 'danger',
    displayTemplate: 'DELETE memo {{id}}',
    inputSchema: MemorizeDeleteInput,
    async execute(ctx: ToolContext, input): Promise<{ deleted: true; id: string }> {
      await deps.knowledge.deleteObject({ id: input.id, userId: ctx.userId });
      return { deleted: true, id: input.id };
    },
  };
}
