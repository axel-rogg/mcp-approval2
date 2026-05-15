/**
 * Docs-Tools — KC-Wrapper fuer kind='doc' Objekte.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2.1 (Storage-Boundary), §7
 *
 * Diese Tools sind duenne Wrapper auf KnowledgeService → HttpKnowledgeAdapter
 * → mcp-knowledge2. Approval-Gateway-Pattern (WYSIWYS): write/danger-Tools
 * gehen durch das Approval-Gate, read-Tools nicht.
 *
 * Tool-Inventar:
 *   - docs.put            (write)  — create/upsert document
 *   - docs.get            (read)
 *   - docs.list           (read)
 *   - docs.delete         (danger) — soft-delete (force fuer refcount>0)
 *   - docs.usages         (read)   — incoming skill-refs
 *   - docs.attach_to      (write)  — batch attach doc to N skills
 *   - docs.update_summary (write)  — encrypted summary + re-embed
 *
 * Body-Encoding: Adapter base64-kodiert intern. Wir akzeptieren string oder
 * Uint8Array. Filename + mime_type werden ans `filename`/`mimeType`-Feld der
 * KC-Create-/Update-Payloads gemappt.
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
  DocsAttachToInput,
  DocsDeleteInput,
  DocsGetInput,
  DocsListInput,
  DocsPutInput,
  DocsUpdateSummaryInput,
  DocsUsagesInput,
  type DocsAttachToInput as DocsAttachToInputT,
  type DocsDeleteInput as DocsDeleteInputT,
  type DocsGetInput as DocsGetInputT,
  type DocsListInput as DocsListInputT,
  type DocsPutInput as DocsPutInputT,
  type DocsUpdateSummaryInput as DocsUpdateSummaryInputT,
  type DocsUsagesInput as DocsUsagesInputT,
} from './types.js';

export interface DocsToolsDeps {
  readonly knowledge: KnowledgeService;
}

// ---------------------------------------------------------------------------
// docs.put — write (create or update)
// ---------------------------------------------------------------------------

export function makeDocsPutTool(deps: DocsToolsDeps): Tool<DocsPutInputT, KnowledgeObject> {
  return {
    name: 'docs.put',
    description:
      'Create or update a markdown/text/binary document. If id is provided, upserts via update; otherwise creates new.',
    sensitivity: 'write',
    displayTemplate: 'Create/Update document: {{filename}}',
    inputSchema: DocsPutInput,
    async execute(ctx: ToolContext, input): Promise<KnowledgeObject> {
      const kcAuth = kcAuthFromCtx(ctx);
      if (input.id !== undefined) {
        // Upsert via update — KC-Service patch
        const patch: UpdateObjectArgs['patch'] = {
          title: input.filename,
          body: input.body,
        };
        if (input.summary !== undefined) {
          (patch as { description?: string | null }).description = input.summary;
        }
        if (input.tags !== undefined) {
          (patch as { keywords?: ReadonlyArray<string> | null }).keywords = input.tags;
        }
        if (input.expected_version !== undefined) {
          (patch as { expectedVersion?: number }).expectedVersion = input.expected_version;
        }
        const meta = buildDocMeta(input);
        if (Object.keys(meta).length > 0) {
          (patch as { meta?: Record<string, unknown> | null }).meta = meta;
        }
        return deps.knowledge.updateObject({
          id: input.id,
          userId: ctx.userId,
          patch,
          ...kcAuth,
        });
      }
      // Create
      const args: CreateObjectArgs = {
        userId: ctx.userId,
        kind: 'doc',
        title: input.filename,
        body: input.body,
        filename: input.filename,
        ...kcAuth,
      };
      if (input.summary !== undefined) {
        (args as { description?: string }).description = input.summary;
      }
      if (input.tags !== undefined) {
        (args as { keywords?: ReadonlyArray<string> }).keywords = input.tags;
      }
      if (input.mime_type !== undefined) {
        (args as { mimeType?: string }).mimeType = input.mime_type;
      }
      const meta = buildDocMeta(input);
      if (Object.keys(meta).length > 0) {
        (args as { meta?: Record<string, unknown> }).meta = meta;
      }
      return deps.knowledge.createObject(args);
    },
  };
}

function buildDocMeta(
  input: DocsPutInputT,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (input.namespace !== undefined) meta['namespace'] = input.namespace;
  if (input.category !== undefined) meta['category'] = input.category;
  return meta;
}

// ---------------------------------------------------------------------------
// docs.get — read
// ---------------------------------------------------------------------------

export function makeDocsGetTool(deps: DocsToolsDeps): Tool<DocsGetInputT, KnowledgeObject> {
  return {
    name: 'docs.get',
    description: 'Fetch a single document by id. Pass expand_body=true to receive the body.',
    sensitivity: 'read',
    inputSchema: DocsGetInput,
    async execute(ctx: ToolContext, input): Promise<KnowledgeObject> {
      return deps.knowledge.getObject({ id: input.id, userId: ctx.userId });
    },
  };
}

// ---------------------------------------------------------------------------
// docs.list — read
// ---------------------------------------------------------------------------

export function makeDocsListTool(deps: DocsToolsDeps): Tool<DocsListInputT, ObjectsList> {
  return {
    name: 'docs.list',
    description:
      "List the current user's documents (kind=doc). Supports paging via limit/cursor and filter by namespace/category/tags/mime_type.",
    sensitivity: 'read',
    inputSchema: DocsListInput,
    async execute(ctx: ToolContext, input): Promise<ObjectsList> {
      const args: Parameters<KnowledgeService['listObjects']>[0] = {
        userId: ctx.userId,
        kind: 'doc',
      };
      if (input.limit !== undefined) (args as { limit?: number }).limit = input.limit;
      if (input.cursor !== undefined) (args as { cursor?: number }).cursor = input.cursor;
      const list = await deps.knowledge.listObjects(args);
      // Optional client-side filter — wire to meta. Server today does not
      // filter on meta-fields, so we narrow post-fetch. Suboptimal but
      // forward-compatible.
      if (
        input.namespace === undefined &&
        input.category === undefined &&
        input.tags === undefined &&
        input.mime_type === undefined
      ) {
        return list;
      }
      const filtered = list.items.filter((obj) => {
        if (input.namespace !== undefined && (obj.meta?.['namespace'] as string | undefined) !== input.namespace) {
          return false;
        }
        if (input.category !== undefined && (obj.meta?.['category'] as string | undefined) !== input.category) {
          return false;
        }
        if (input.mime_type !== undefined && obj.mimeType !== input.mime_type) {
          return false;
        }
        if (input.tags !== undefined && input.tags.length > 0) {
          const kw = obj.keywords ?? [];
          if (!input.tags.every((t) => kw.includes(t))) return false;
        }
        return true;
      });
      return { items: filtered, nextCursor: list.nextCursor };
    },
  };
}

// ---------------------------------------------------------------------------
// docs.delete — danger
// ---------------------------------------------------------------------------

export function makeDocsDeleteTool(deps: DocsToolsDeps): Tool<DocsDeleteInputT, { deleted: true; id: string }> {
  return {
    name: 'docs.delete',
    description:
      'Soft-delete a document. If refcount > 0 (still referenced by skills), pass force=true to override.',
    sensitivity: 'danger',
    displayTemplate: 'DELETE document {{id}}{{#force}} (force){{/force}}',
    inputSchema: DocsDeleteInput,
    async execute(ctx: ToolContext, input): Promise<{ deleted: true; id: string }> {
      const kcAuth = kcAuthFromCtx(ctx);
      if (input.force !== true) {
        const obj = await deps.knowledge.getObject({ id: input.id, userId: ctx.userId, ...kcAuth });
        if (obj.refcount > 0) {
          throw new Error(
            `docs.delete: document is still referenced by ${obj.refcount} skill(s); pass force=true to override`,
          );
        }
      }
      await deps.knowledge.deleteObject({ id: input.id, userId: ctx.userId, ...kcAuth });
      return { deleted: true, id: input.id };
    },
  };
}

// ---------------------------------------------------------------------------
// docs.usages — read (incoming refs)
// ---------------------------------------------------------------------------

export function makeDocsUsagesTool(
  deps: DocsToolsDeps,
): Tool<DocsUsagesInputT, { incoming: ReadonlyArray<{ kind: 'skill'; id: string; title: string | null }>; outgoing: ReadonlyArray<{ kind: string; id: string }> }> {
  return {
    name: 'docs.usages',
    description: 'List incoming references to a document (which skills attach it as a resource).',
    sensitivity: 'read',
    inputSchema: DocsUsagesInput,
    async execute(ctx: ToolContext, input) {
      return deps.knowledge.docUsages({ userId: ctx.userId, docId: input.id });
    },
  };
}

// ---------------------------------------------------------------------------
// docs.attach_to — write (batch attach to N skills)
// ---------------------------------------------------------------------------

export function makeDocsAttachToTool(
  deps: DocsToolsDeps,
): Tool<DocsAttachToInputT, { attached: ReadonlyArray<string>; alreadyPresent: ReadonlyArray<string> }> {
  return {
    name: 'docs.attach_to',
    description:
      'Attach a document as a resource to multiple skills in one approval. Idempotent per skill.',
    sensitivity: 'write',
    displayTemplate: 'Attach doc {{doc_id}} to skills: {{skill_ids}}',
    inputSchema: DocsAttachToInput,
    async execute(ctx: ToolContext, input) {
      return deps.knowledge.attachDocToSkills({
        userId: ctx.userId,
        docId: input.doc_id,
        skillIds: input.skill_ids,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// docs.update_summary — write (encrypted summary + re-embed)
// ---------------------------------------------------------------------------

export function makeDocsUpdateSummaryTool(
  deps: DocsToolsDeps,
): Tool<DocsUpdateSummaryInputT, KnowledgeObject> {
  return {
    name: 'docs.update_summary',
    description:
      'Update the encrypted summary of a document. Triggers server-side re-embed unless re_embed=false.',
    sensitivity: 'write',
    displayTemplate: 'Update summary for doc {{id}} ({{summary.length}} chars)',
    inputSchema: DocsUpdateSummaryInput,
    async execute(ctx: ToolContext, input): Promise<KnowledgeObject> {
      const args: Parameters<KnowledgeService['updateDocSummary']>[0] = {
        userId: ctx.userId,
        docId: input.id,
        summary: input.summary,
      };
      if (input.re_embed !== undefined) {
        (args as { reEmbed?: boolean }).reEmbed = input.re_embed;
      }
      return deps.knowledge.updateDocSummary(args);
    },
  };
}
