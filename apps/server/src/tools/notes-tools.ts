/**
 * Notes-Tools — KC-Wrapper fuer subtype='note' Objekte.
 *
 * Plan-Ref: docs/plans/active/PLAN-wrapper-conventions.md §"Body-Formate /
 * subtype='note'".
 *
 * Notes sind freie Markdown-Dokumente. Body hat keine strikte Struktur (im
 * Gegensatz zu Lists). Optional `embed: true` triggert Vector-Embedding via
 * `description` (KC-Service triggert das server-seitig).
 *
 * Tool-Inventar:
 *   - notes.create (write)
 *   - notes.update (write)  — full-replace body/title/description
 *   - notes.list   (read)
 *   - notes.get    (read)
 *   - notes.delete (danger) — soft-delete
 */
import type {
  CreateObjectArgs,
  KnowledgeObject,
  ObjectsList,
  UpdateObjectArgs,
} from '@mcp-approval2/adapters';
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';
import { kcAuthFromCtx, type KnowledgeService } from '../services/knowledge.js';
import {
  NOTE_SUBTYPE,
  NotesCreateInput,
  NotesDeleteInput,
  NotesGetInput,
  NotesListInput,
  NotesUpdateInput,
  type NotesCreateInput as NotesCreateInputT,
  type NotesDeleteInput as NotesDeleteInputT,
  type NotesGetInput as NotesGetInputT,
  type NotesListInput as NotesListInputT,
  type NotesUpdateInput as NotesUpdateInputT,
} from './types.js';

export interface NotesToolsDeps {
  readonly knowledge: KnowledgeService;
}

// ---------------------------------------------------------------------------
// notes.create — write
// ---------------------------------------------------------------------------

export function makeNotesCreateTool(deps: NotesToolsDeps): Tool<NotesCreateInputT, KnowledgeObject> {
  return {
    name: 'notes.create',
    description:
      'Create a Markdown note with title + body. Optional summary (`description`) — if embed=true, KC2 indexes it for semantic search.',
    sensitivity: 'write',
    // SEC-020: body-Preview im Display damit User sieht WAS gespeichert wird.
    displayTemplate: 'Create note: {{title}} — {{body|preview:120}}',
    inputSchema: NotesCreateInput,
    async execute(ctx: ToolContext, input): Promise<KnowledgeObject> {
      const kcAuth = kcAuthFromCtx(ctx);
      const args: CreateObjectArgs = {
        userId: ctx.userId,
        subtype: NOTE_SUBTYPE,
        title: input.title,
        body: input.body,
        ...kcAuth,
      };
      if (input.description !== undefined) {
        (args as { description?: string }).description = input.description;
      }
      if (input.keywords !== undefined) {
        (args as { keywords?: ReadonlyArray<string> }).keywords = input.keywords;
      }
      if (input.embed === true) {
        (args as { embed?: boolean }).embed = true;
      }
      return deps.knowledge.createObject(args);
    },
  };
}

// ---------------------------------------------------------------------------
// notes.update — write (full-replace)
// ---------------------------------------------------------------------------

export function makeNotesUpdateTool(deps: NotesToolsDeps): Tool<NotesUpdateInputT, KnowledgeObject> {
  return {
    name: 'notes.update',
    description:
      'Update a note (full-replace of provided fields). At least one of title/body/description/keywords required.',
    sensitivity: 'write',
    // SEC-020: zeigt was geupdated wird — sonst kann IPI "save my note" voraukklicken + Original ueberschreiben.
    displayTemplate: 'Update note {{id}} — title:{{title|preview:60}} body:{{body|preview:120}}',
    inputSchema: NotesUpdateInput,
    async execute(ctx: ToolContext, input): Promise<KnowledgeObject> {
      const kcAuth = kcAuthFromCtx(ctx);
      const patch: UpdateObjectArgs['patch'] = {};
      if (input.title !== undefined) (patch as { title?: string }).title = input.title;
      if (input.body !== undefined) (patch as { body?: string }).body = input.body;
      if (input.description !== undefined) {
        (patch as { description?: string | null }).description = input.description;
      }
      if (input.keywords !== undefined) {
        (patch as { keywords?: ReadonlyArray<string> | null }).keywords = input.keywords;
      }
      if (input.expected_version !== undefined) {
        (patch as { expectedVersion?: number }).expectedVersion = input.expected_version;
      }
      return deps.knowledge.updateObject({
        id: input.id,
        userId: ctx.userId,
        patch,
        ...kcAuth,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// notes.list — read
// ---------------------------------------------------------------------------

export function makeNotesListTool(deps: NotesToolsDeps): Tool<NotesListInputT, ObjectsList> {
  return {
    name: 'notes.list',
    description: "List the current user's notes (subtype=note). Supports paging via limit/cursor.",
    sensitivity: 'read',
    inputSchema: NotesListInput,
    async execute(ctx: ToolContext, input): Promise<ObjectsList> {
      const args: Parameters<KnowledgeService['listObjects']>[0] = {
        userId: ctx.userId,
        subtype: NOTE_SUBTYPE,
      };
      if (input.limit !== undefined) (args as { limit?: number }).limit = input.limit;
      if (input.cursor !== undefined) (args as { cursor?: number }).cursor = input.cursor;
      return deps.knowledge.listObjects(args);
    },
  };
}

// ---------------------------------------------------------------------------
// notes.get — read
// ---------------------------------------------------------------------------

export function makeNotesGetTool(deps: NotesToolsDeps): Tool<NotesGetInputT, KnowledgeObject> {
  return {
    name: 'notes.get',
    description: 'Fetch a single note by id (with body expanded).',
    sensitivity: 'read',
    inputSchema: NotesGetInput,
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
// notes.delete — danger
// ---------------------------------------------------------------------------

export function makeNotesDeleteTool(
  deps: NotesToolsDeps,
): Tool<NotesDeleteInputT, { deleted: true; id: string }> {
  return {
    name: 'notes.delete',
    description: 'Soft-delete a note by id.',
    sensitivity: 'danger',
    displayTemplate: 'DELETE note {{id}}',
    inputSchema: NotesDeleteInput,
    async execute(ctx: ToolContext, input): Promise<{ deleted: true; id: string }> {
      const kcAuth = kcAuthFromCtx(ctx);
      await deps.knowledge.deleteObject({ id: input.id, userId: ctx.userId, ...kcAuth });
      return { deleted: true, id: input.id };
    },
  };
}
