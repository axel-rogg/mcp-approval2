/**
 * Bookmarks-Tools — KC-Wrapper fuer subtype='bookmark' Objekte.
 *
 * Plan-Ref: docs/plans/active/PLAN-wrapper-conventions.md §"Body-Formate /
 * subtype='bookmark'".
 *
 * Bookmark = Title (`objects.title`) + URL (`meta.url`) + optional Notes
 * (Markdown im Body). Keine Frontmatter — die URL liegt strukturell im
 * `meta`-Feld, damit Filter/Discovery sauber laufen.
 *
 * Tool-Inventar:
 *   - bookmarks.create (write)
 *   - bookmarks.list   (read)
 *   - bookmarks.get    (read)
 *   - bookmarks.delete (danger) — soft-delete
 */
import type {
  CreateObjectArgs,
  KnowledgeObject,
  ObjectsList,
} from '@mcp-approval2/adapters';
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';
import { kcAuthFromCtx, type KnowledgeService } from '../services/knowledge.js';
import {
  BOOKMARK_SUBTYPE,
  BookmarksCreateInput,
  BookmarksDeleteInput,
  BookmarksGetInput,
  BookmarksListInput,
  type BookmarksCreateInput as BookmarksCreateInputT,
  type BookmarksDeleteInput as BookmarksDeleteInputT,
  type BookmarksGetInput as BookmarksGetInputT,
  type BookmarksListInput as BookmarksListInputT,
} from './types.js';

export interface BookmarksToolsDeps {
  readonly knowledge: KnowledgeService;
}

// ---------------------------------------------------------------------------
// bookmarks.create — write
// ---------------------------------------------------------------------------

export function makeBookmarksCreateTool(
  deps: BookmarksToolsDeps,
): Tool<BookmarksCreateInputT, KnowledgeObject> {
  return {
    name: 'bookmarks.create',
    description:
      'Create a new bookmark with title + URL. Notes are optional Markdown; URL is stored in meta.url.',
    sensitivity: 'write',
    // SEC-020: notes-preview damit User sieht ob neben URL noch Free-Text gespeichert wird.
    displayTemplate: 'Bookmark: {{title}} ({{url}}) — {{notes|preview:120}}',
    inputSchema: BookmarksCreateInput,
    async execute(ctx: ToolContext, input): Promise<KnowledgeObject> {
      const kcAuth = kcAuthFromCtx(ctx);
      const body = input.notes !== undefined && input.notes.length > 0 ? input.notes : input.title;
      const args: CreateObjectArgs = {
        userId: ctx.userId,
        subtype: BOOKMARK_SUBTYPE,
        title: input.title,
        body,
        meta: { url: input.url },
        ...kcAuth,
      };
      if (input.keywords !== undefined) {
        (args as { keywords?: ReadonlyArray<string> }).keywords = input.keywords;
      }
      return deps.knowledge.createObject(args);
    },
  };
}

// ---------------------------------------------------------------------------
// bookmarks.list — read
// ---------------------------------------------------------------------------

export function makeBookmarksListTool(
  deps: BookmarksToolsDeps,
): Tool<BookmarksListInputT, ObjectsList> {
  return {
    name: 'bookmarks.list',
    description: "List the current user's bookmarks (subtype=bookmark). Supports paging via limit/cursor.",
    sensitivity: 'read',
    inputSchema: BookmarksListInput,
    async execute(ctx: ToolContext, input): Promise<ObjectsList> {
      const args: Parameters<KnowledgeService['listObjects']>[0] = {
        userId: ctx.userId,
        subtype: BOOKMARK_SUBTYPE,
      };
      if (input.limit !== undefined) (args as { limit?: number }).limit = input.limit;
      if (input.cursor !== undefined) (args as { cursor?: number }).cursor = input.cursor;
      return deps.knowledge.listObjects(args);
    },
  };
}

// ---------------------------------------------------------------------------
// bookmarks.get — read
// ---------------------------------------------------------------------------

export function makeBookmarksGetTool(
  deps: BookmarksToolsDeps,
): Tool<BookmarksGetInputT, KnowledgeObject> {
  return {
    name: 'bookmarks.get',
    description: 'Fetch a single bookmark by id (with body/notes expanded).',
    sensitivity: 'read',
    inputSchema: BookmarksGetInput,
    async execute(ctx: ToolContext, input): Promise<KnowledgeObject> {
      return deps.knowledge.getObject({
        id: input.id,
        userId: ctx.userId,
        expandBody: true,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// bookmarks.delete — danger
// ---------------------------------------------------------------------------

export function makeBookmarksDeleteTool(
  deps: BookmarksToolsDeps,
): Tool<BookmarksDeleteInputT, { deleted: true; id: string }> {
  return {
    name: 'bookmarks.delete',
    description: 'Soft-delete a bookmark by id.',
    sensitivity: 'danger',
    displayTemplate: 'DELETE bookmark {{id}}',
    inputSchema: BookmarksDeleteInput,
    async execute(ctx: ToolContext, input): Promise<{ deleted: true; id: string }> {
      const kcAuth = kcAuthFromCtx(ctx);
      await deps.knowledge.deleteObject({ id: input.id, userId: ctx.userId, ...kcAuth });
      return { deleted: true, id: input.id };
    },
  };
}
