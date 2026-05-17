/**
 * Skills-Tools — KC-Wrapper fuer subtype='skill_manifest' Objekte.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2.1, §7
 *
 * Skills = Bundle aus Manifest (Markdown im body) + Resources (Docs, gelinkt
 * ueber `meta.resource_ids: string[]`). Diese Tools forwarden alle Schreib-/
 * Lese-Ops an KnowledgeService → mcp-knowledge2.
 *
 * Tool-Inventar:
 *   - skills.put             (write)
 *   - skills.get             (read)
 *   - skills.list            (read)
 *   - skills.delete          (danger)
 *   - skills.search          (read)  — server-side hybrid (FTS + Vector)
 *   - skills.read_resource   (read)
 *   - skills.attach_resource (write)
 */
import type {
  CreateObjectArgs,
  KnowledgeObject,
  ObjectsList,
  SearchHit,
  UpdateObjectArgs,
} from '@mcp-approval2/adapters';
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';
import type { KnowledgeService } from '../services/knowledge.js';
import {
  SkillsAttachResourceInput,
  SkillsDeleteInput,
  SkillsDetachResourceInput,
  SkillsGetBundleInput,
  SkillsGetInput,
  SkillsListInput,
  SkillsPutInput,
  SkillsReadResourceInput,
  SkillsSearchInput,
  type SkillsAttachResourceInput as SkillsAttachResourceInputT,
  type SkillsDeleteInput as SkillsDeleteInputT,
  type SkillsDetachResourceInput as SkillsDetachResourceInputT,
  type SkillsGetBundleInput as SkillsGetBundleInputT,
  type SkillsGetInput as SkillsGetInputT,
  type SkillsListInput as SkillsListInputT,
  type SkillsPutInput as SkillsPutInputT,
  type SkillsReadResourceInput as SkillsReadResourceInputT,
  type SkillsSearchInput as SkillsSearchInputT,
} from './types.js';

export interface SkillsToolsDeps {
  readonly knowledge: KnowledgeService;
}

// ---------------------------------------------------------------------------
// skills.put — write
// ---------------------------------------------------------------------------

export function makeSkillsPutTool(deps: SkillsToolsDeps): Tool<SkillsPutInputT, KnowledgeObject> {
  return {
    name: 'skills.put',
    description:
      'Create or update a skill (manifest in body, optional linked resource_ids). If id is provided, upserts; otherwise creates new.',
    sensitivity: 'write',
    displayTemplate: 'Save skill: {{title}}',
    inputSchema: SkillsPutInput,
    async execute(ctx: ToolContext, input): Promise<KnowledgeObject> {
      const meta = buildSkillMeta(input);
      if (input.id !== undefined) {
        const patch: UpdateObjectArgs['patch'] = {
          title: input.title,
          body: input.manifest,
        };
        if (input.description !== undefined) {
          (patch as { description?: string | null }).description = input.description;
        }
        if (input.keywords !== undefined) {
          (patch as { keywords?: ReadonlyArray<string> | null }).keywords = input.keywords;
        }
        if (input.trigger_hints !== undefined) {
          (patch as { triggerHints?: string | null }).triggerHints = input.trigger_hints;
        }
        if (input.expected_version !== undefined) {
          (patch as { expectedVersion?: number }).expectedVersion = input.expected_version;
        }
        if (Object.keys(meta).length > 0) {
          (patch as { meta?: Record<string, unknown> | null }).meta = meta;
        }
        return deps.knowledge.updateObject({
          id: input.id,
          userId: ctx.userId,
          patch,
        });
      }
      // Create
      const args: CreateObjectArgs = {
        userId: ctx.userId,
        subtype: 'skill_manifest',
        title: input.title,
        body: input.manifest,
      };
      if (input.description !== undefined) {
        (args as { description?: string }).description = input.description;
      }
      if (input.keywords !== undefined) {
        (args as { keywords?: ReadonlyArray<string> }).keywords = input.keywords;
      }
      if (input.trigger_hints !== undefined) {
        (args as { triggerHints?: string }).triggerHints = input.trigger_hints;
      }
      if (Object.keys(meta).length > 0) {
        (args as { meta?: Record<string, unknown> }).meta = meta;
      }
      return deps.knowledge.createObject(args);
    },
  };
}

function buildSkillMeta(input: SkillsPutInputT): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (input.groups !== undefined) meta['groups'] = input.groups;
  if (input.resource_ids !== undefined) meta['resource_ids'] = input.resource_ids;
  return meta;
}

// ---------------------------------------------------------------------------
// skills.get — read
// ---------------------------------------------------------------------------

export function makeSkillsGetTool(deps: SkillsToolsDeps): Tool<SkillsGetInputT, KnowledgeObject> {
  return {
    name: 'skills.get',
    description:
      'Fetch a skill (manifest + linked resource_ids via meta). Pass expand_body=true for the manifest text.',
    sensitivity: 'read',
    inputSchema: SkillsGetInput,
    async execute(ctx: ToolContext, input): Promise<KnowledgeObject> {
      return deps.knowledge.getObject({ id: input.id, userId: ctx.userId });
    },
  };
}

// ---------------------------------------------------------------------------
// skills.list — read
// ---------------------------------------------------------------------------

export function makeSkillsListTool(deps: SkillsToolsDeps): Tool<SkillsListInputT, ObjectsList> {
  return {
    name: 'skills.list',
    description: "List the current user's skills (subtype=skill_manifest). Optional filter by group (meta.groups).",
    sensitivity: 'read',
    inputSchema: SkillsListInput,
    async execute(ctx: ToolContext, input): Promise<ObjectsList> {
      const args: Parameters<KnowledgeService['listObjects']>[0] = {
        userId: ctx.userId,
        subtype: 'skill_manifest',
      };
      if (input.limit !== undefined) (args as { limit?: number }).limit = input.limit;
      if (input.cursor !== undefined) (args as { cursor?: number }).cursor = input.cursor;
      const list = await deps.knowledge.listObjects(args);
      if (input.group === undefined) return list;
      const target = input.group;
      const filtered = list.items.filter((obj) => {
        const groups = obj.meta?.['groups'];
        if (!Array.isArray(groups)) return false;
        return groups.includes(target);
      });
      return { items: filtered, nextCursor: list.nextCursor };
    },
  };
}

// ---------------------------------------------------------------------------
// skills.delete — danger
// ---------------------------------------------------------------------------

export function makeSkillsDeleteTool(
  deps: SkillsToolsDeps,
): Tool<SkillsDeleteInputT, { deleted: true; id: string }> {
  return {
    name: 'skills.delete',
    description: 'Delete a skill. If force=true, deletes even when refcount>0.',
    sensitivity: 'danger',
    displayTemplate: 'DELETE skill {{id}}{{#force}} (force){{/force}}',
    inputSchema: SkillsDeleteInput,
    async execute(ctx: ToolContext, input): Promise<{ deleted: true; id: string }> {
      if (input.force !== true) {
        const obj = await deps.knowledge.getObject({ id: input.id, userId: ctx.userId });
        if (obj.refcount > 0) {
          throw new Error(
            `skills.delete: skill is still referenced (refcount=${obj.refcount}); pass force=true to override`,
          );
        }
      }
      await deps.knowledge.deleteObject({ id: input.id, userId: ctx.userId });
      return { deleted: true, id: input.id };
    },
  };
}

// ---------------------------------------------------------------------------
// skills.search — read (server-side hybrid FTS+Vector)
// ---------------------------------------------------------------------------

export function makeSkillsSearchTool(
  deps: SkillsToolsDeps,
): Tool<SkillsSearchInputT, { hits: ReadonlyArray<SearchHit> }> {
  return {
    name: 'skills.search',
    description:
      'Hybrid search across skills (FTS + Vector). Returns ranked hits restricted to subtype=skill_manifest.',
    sensitivity: 'read',
    inputSchema: SkillsSearchInput,
    async execute(ctx: ToolContext, input): Promise<{ hits: ReadonlyArray<SearchHit> }> {
      const args: Parameters<KnowledgeService['search']>[0] = {
        userId: ctx.userId,
        query: input.query,
        subtypes: ['skill_manifest'],
      };
      if (input.limit !== undefined) (args as { limit?: number }).limit = input.limit;
      const hits = await deps.knowledge.search(args);
      return { hits };
    },
  };
}

// ---------------------------------------------------------------------------
// skills.read_resource — read
// ---------------------------------------------------------------------------

export function makeSkillsReadResourceTool(
  deps: SkillsToolsDeps,
): Tool<SkillsReadResourceInputT, KnowledgeObject> {
  return {
    name: 'skills.read_resource',
    description:
      'Read a doc that is attached to a skill as a resource (verifies attachment before reading the body).',
    sensitivity: 'read',
    inputSchema: SkillsReadResourceInput,
    async execute(ctx: ToolContext, input): Promise<KnowledgeObject> {
      return deps.knowledge.readSkillResource({
        userId: ctx.userId,
        skillId: input.skill_id,
        resourceId: input.resource_id,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// skills.get_bundle — read (PLAN-document-linking §10.5 R15, §9 P9)
//
// Symmetrische Surface zu skills.put(+attach): liefert Skill-Manifest UND
// alle attached Resource-Bodies in EINEM Call. Implementiert als thin
// wrapper auf knowledge.getObject mit includeRefBodies=['resource'].
//
// Token-Budget: KC2-Seite cap'd auf 200 KB total + 1 MB per-ref. Bei
// Überschreitung: truncatedReason='oversized'/'budget' pro Ref.
// ---------------------------------------------------------------------------

export function makeSkillsGetBundleTool(
  deps: SkillsToolsDeps,
): Tool<SkillsGetBundleInputT, KnowledgeObject> {
  return {
    name: 'skills.get_bundle',
    description:
      'Read a skill manifest + ALL its attached resource bodies in one call. ' +
      'Useful for executing a skill (you need both the manifest and the resources). ' +
      'Returns manifest object with refs.outgoing[] where each role="resource" ' +
      'entry has its body inlined as base64. Subject to 200 KB total + 1 MB per-ref ' +
      'budget — oversized/over-budget refs come back without body and a truncatedReason. ' +
      'For pure manifest read use skills.get (no body fetch overhead).',
    sensitivity: 'read',
    inputSchema: SkillsGetBundleInput,
    async execute(ctx: ToolContext, input): Promise<KnowledgeObject> {
      return deps.knowledge.getObject({
        userId: ctx.userId,
        userEmail: ctx.email,
        id: input.id,
        expandBody: true,
        refsLimit: input.refs_limit ?? 20,
        includeRefBodies: ['resource'],
      });
    },
  };
}

// ---------------------------------------------------------------------------
// skills.attach_resource — write  (PLAN-document-linking §10.5 D4, P7)
//
// Schaltet auf native KC2-Refs um: object_refs(role='resource'). Idempotent
// via KC2's ON CONFLICT DO NOTHING. Legacy `meta.resource_ids[]` wird hier
// nicht mehr geschrieben — bei alten Skills existieren beide Pfade parallel
// (Storage-Detail-View liest beide).
// ---------------------------------------------------------------------------

export function makeSkillsAttachResourceTool(
  deps: SkillsToolsDeps,
): Tool<SkillsAttachResourceInputT, { ok: true; warnings: string[] }> {
  return {
    name: 'skills.attach_resource',
    description:
      'Attach a doc as a resource to a skill. Idempotent (re-attach is a no-op). ' +
      'Creates a knowledge-graph ref role="resource" — Agent lädt das Doc mit ' +
      'wenn der Skill geladen wird (siehe objects.get refs.outgoing[]).',
    sensitivity: 'write',
    displayTemplate: 'Attach doc {{doc_id}} as resource to skill {{skill_id}}',
    inputSchema: SkillsAttachResourceInput,
    async execute(ctx: ToolContext, input): Promise<{ ok: true; warnings: string[] }> {
      await deps.knowledge.addRef({
        userId: ctx.userId,
        userEmail: ctx.email,
        ...(ctx.approvalId !== undefined ? { approvalId: ctx.approvalId } : {}),
        fromId: input.skill_id,
        toId: input.doc_id,
        role: 'resource',
      });
      // KC2 returns warnings via the route response, but the adapter's
      // addRef currently swallows the body (POST returns 204 on clean).
      // We expose ok+empty-warnings to keep the tool-response shape stable;
      // when adapter is extended to surface warnings, this returns them.
      return { ok: true, warnings: [] };
    },
  };
}

// ---------------------------------------------------------------------------
// skills.detach_resource — write  (PLAN-document-linking §10.5 P7)
// ---------------------------------------------------------------------------

export function makeSkillsDetachResourceTool(
  deps: SkillsToolsDeps,
): Tool<SkillsDetachResourceInputT, { ok: true }> {
  return {
    name: 'skills.detach_resource',
    description:
      'Remove a resource link from a skill. Idempotent (remove of non-existent is a no-op). ' +
      'Does NOT delete the doc — only the knowledge-graph edge. If doc was attached only ' +
      'to this skill, doc.is_subdoc flips back to false.',
    sensitivity: 'write',
    displayTemplate: 'Detach doc {{doc_id}} from skill {{skill_id}}',
    inputSchema: SkillsDetachResourceInput,
    async execute(ctx: ToolContext, input): Promise<{ ok: true }> {
      await deps.knowledge.removeRef({
        userId: ctx.userId,
        userEmail: ctx.email,
        ...(ctx.approvalId !== undefined ? { approvalId: ctx.approvalId } : {}),
        fromId: input.skill_id,
        toId: input.doc_id,
        role: 'resource',
      });
      return { ok: true };
    },
  };
}
