/**
 * Group-Sharing Tool-Surface (Phase 1 + Phase 2-1).
 *
 * Plan-Ref: docs/plans/active/PLAN-sharing-group-phase-1.md §8 (KC2-Plan)
 *           + cross-repo ADR-0024 in mcp-approval2/docs/adr/
 *
 * Phase-1-Tools (5 Kern-Tools, live seit 2026-05-17):
 *   - groups.create         (write — User-initiated, Auto-Bypass im Write-Mode)
 *   - groups.list           (read)
 *   - groups.add_member     (write mit displayTemplate-Warning)
 *   - groups.remove_member  (write — owner-only, triggert Master-Rotation)
 *   - skills.share_with_group (write — Lazy-Migration + Bundle-Cascade)
 *
 * Phase-2-1-Tools (7 weitere, 2026-05-18):
 *   - groups.get             (read — full group + members)
 *   - groups.list_members    (read — convenience-alias auf groups.get)
 *   - groups.archive         (write — owner-only, soft-delete)
 *   - groups.set_read_audit  (write — owner-only toggle)
 *   - docs.share_with_group  (write — Group-Grant fuer Single-Doc, kein Cascade)
 *   - shares.revoke          (write — Group-aware via shareId)
 *   - shares.list_my_shares  (read — Inbound-View: was wurde mir gegeben)
 *
 * Sensitivity-Decision: add_member ist 'write' (nicht 'danger'), aber das
 * displayTemplate macht den Impact-Hinweis explizit. PLAN-Review §5: 'danger'
 * würde PRF-Eval triggern, das ist für add_member overkill. Wenn später
 * Schaden-Reports auftauchen, kann auf 'danger' upgegradet werden.
 */
import { z } from 'zod';
import type {
  Group,
  GroupMember,
  GroupShare,
  Share,
} from '@mcp-approval2/adapters';
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';
import type { KnowledgeService } from '../services/knowledge.js';

export interface GroupsToolsDeps {
  readonly knowledge: KnowledgeService;
}

// ─── Zod-Schemas (inline) ──────────────────────────────────────────────────

const GroupsCreateInput = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    read_audit_enabled: z.boolean().optional(),
    cascade_on_share_default: z.boolean().optional(),
  })
  .strict();
type GroupsCreateInputT = z.infer<typeof GroupsCreateInput>;

const GroupsListInput = z.object({}).strict();
type GroupsListInputT = z.infer<typeof GroupsListInput>;

const GroupsAddMemberInput = z
  .object({
    group_id: z.string().uuid(),
    user_id: z.string().uuid(),
    role: z.enum(['admin', 'member']).optional(),
  })
  .strict();
type GroupsAddMemberInputT = z.infer<typeof GroupsAddMemberInput>;

const GroupsRemoveMemberInput = z
  .object({
    group_id: z.string().uuid(),
    user_id: z.string().uuid(),
  })
  .strict();
type GroupsRemoveMemberInputT = z.infer<typeof GroupsRemoveMemberInput>;

const SkillsShareWithGroupInput = z
  .object({
    skill_id: z.string().uuid(),
    group_id: z.string().uuid(),
    expires_at: z.number().int().nullable().optional(),
  })
  .strict();
type SkillsShareWithGroupInputT = z.infer<typeof SkillsShareWithGroupInput>;

// ─── Phase 2-1 Schemas ─────────────────────────────────────────────────────

const GroupsGetInput = z
  .object({
    group_id: z.string().uuid(),
  })
  .strict();
type GroupsGetInputT = z.infer<typeof GroupsGetInput>;

const GroupsListMembersInput = z
  .object({
    group_id: z.string().uuid(),
  })
  .strict();
type GroupsListMembersInputT = z.infer<typeof GroupsListMembersInput>;

const GroupsArchiveInput = z
  .object({
    group_id: z.string().uuid(),
  })
  .strict();
type GroupsArchiveInputT = z.infer<typeof GroupsArchiveInput>;

const GroupsSetReadAuditInput = z
  .object({
    group_id: z.string().uuid(),
    enabled: z.boolean(),
  })
  .strict();
type GroupsSetReadAuditInputT = z.infer<typeof GroupsSetReadAuditInput>;

const DocsShareWithGroupInput = z
  .object({
    doc_id: z.string().uuid(),
    group_id: z.string().uuid(),
    expires_at: z.number().int().nullable().optional(),
  })
  .strict();
type DocsShareWithGroupInputT = z.infer<typeof DocsShareWithGroupInput>;

const SharesRevokeInput = z
  .object({
    share_id: z.string().uuid(),
  })
  .strict();
type SharesRevokeInputT = z.infer<typeof SharesRevokeInput>;

const SharesListMySharesInput = z.object({}).strict();
type SharesListMySharesInputT = z.infer<typeof SharesListMySharesInput>;

// ─── Helper: KC-Auth aus Context ───────────────────────────────────────────

function kcAuth(ctx: ToolContext): { userEmail?: string; approvalId?: string } {
  const out: { userEmail?: string; approvalId?: string } = {};
  if (ctx.email) out.userEmail = ctx.email;
  if (ctx.approvalId !== undefined) out.approvalId = ctx.approvalId;
  return out;
}

// ─── Tool-Factories ────────────────────────────────────────────────────────

export function makeGroupsCreateTool(deps: GroupsToolsDeps): Tool<GroupsCreateInputT, Group> {
  return {
    name: 'groups.create',
    description:
      'Create a new sharing group. The current user becomes the group owner + first admin member. Other users can be added later via groups.add_member.',
    sensitivity: 'write',
    displayTemplate: 'Create new sharing group: "{{name}}"',
    inputSchema: GroupsCreateInput,
    async execute(ctx: ToolContext, input): Promise<Group> {
      return deps.knowledge.createGroup({
        userId: ctx.userId,
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.read_audit_enabled !== undefined
          ? { readAuditEnabled: input.read_audit_enabled }
          : {}),
        ...(input.cascade_on_share_default !== undefined
          ? { cascadeOnShareDefault: input.cascade_on_share_default }
          : {}),
        ...kcAuth(ctx),
      });
    },
  };
}

export function makeGroupsListTool(
  deps: GroupsToolsDeps,
): Tool<GroupsListInputT, { items: ReadonlyArray<Group> }> {
  return {
    name: 'groups.list',
    description: 'List the groups the current user owns or is a member of.',
    sensitivity: 'read',
    inputSchema: GroupsListInput,
    async execute(ctx: ToolContext): Promise<{ items: ReadonlyArray<Group> }> {
      const items = await deps.knowledge.listGroups({
        userId: ctx.userId,
        ...kcAuth(ctx),
      });
      return { items };
    },
  };
}

export function makeGroupsAddMemberTool(
  deps: GroupsToolsDeps,
): Tool<GroupsAddMemberInputT, GroupMember> {
  return {
    name: 'groups.add_member',
    description:
      'Add a user to a sharing group. **Important:** the user can read ALL group-shared content immediately after this action. The action is reversible (groups.remove_member triggers a master-key rotation), but already-read content can never be recalled.',
    sensitivity: 'write',
    displayTemplate:
      'Add user {{user_id}} as {{role}} to group {{group_id}} — they will be able to read ALL group-shared content immediately.',
    inputSchema: GroupsAddMemberInput,
    async execute(ctx: ToolContext, input): Promise<GroupMember> {
      return deps.knowledge.addGroupMember({
        userId: ctx.userId,
        groupId: input.group_id,
        targetUserId: input.user_id,
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...kcAuth(ctx),
      });
    },
  };
}

export function makeGroupsRemoveMemberTool(
  deps: GroupsToolsDeps,
): Tool<GroupsRemoveMemberInputT, { ok: true }> {
  return {
    name: 'groups.remove_member',
    description:
      'Remove a user from a sharing group. Triggers a master-key rotation: the removed user cannot read newly-shared content. Already-downloaded content cannot be recalled.',
    sensitivity: 'write',
    displayTemplate:
      'Remove user {{user_id}} from group {{group_id}} (master-key rotation will be triggered).',
    inputSchema: GroupsRemoveMemberInput,
    async execute(ctx: ToolContext, input): Promise<{ ok: true }> {
      await deps.knowledge.removeGroupMember({
        userId: ctx.userId,
        groupId: input.group_id,
        targetUserId: input.user_id,
        ...kcAuth(ctx),
      });
      return { ok: true };
    },
  };
}

export function makeSkillsShareWithGroupTool(
  deps: GroupsToolsDeps,
): Tool<SkillsShareWithGroupInputT, GroupShare> {
  return {
    name: 'skills.share_with_group',
    description:
      'Share a skill (and all linked skill_resource documents via auto-cascade) with a group. All group members will be able to read the skill + its bundled documents. Use shares.revoke to undo.',
    sensitivity: 'write',
    displayTemplate:
      'Share skill {{skill_id}} with group {{group_id}} (read-only). All linked skill_resource documents are auto-shared via cascade.',
    inputSchema: SkillsShareWithGroupInput,
    async execute(ctx: ToolContext, input): Promise<GroupShare> {
      return deps.knowledge.createShareWithGroup({
        userId: ctx.userId,
        resourceId: input.skill_id,
        groupId: input.group_id,
        scope: 'read',
        ...(input.expires_at !== undefined ? { expiresAt: input.expires_at } : {}),
        ...kcAuth(ctx),
      });
    },
  };
}

// ─── Phase 2-1 Tool-Factories ──────────────────────────────────────────────

export function makeGroupsGetTool(
  deps: GroupsToolsDeps,
): Tool<GroupsGetInputT, { group: Group; members: ReadonlyArray<GroupMember> }> {
  return {
    name: 'groups.get',
    description:
      'Read a group and its member list. Both owner and active members can read; non-members get a not-found error from RLS.',
    sensitivity: 'read',
    inputSchema: GroupsGetInput,
    async execute(
      ctx: ToolContext,
      input,
    ): Promise<{ group: Group; members: ReadonlyArray<GroupMember> }> {
      return deps.knowledge.getGroup({
        userId: ctx.userId,
        groupId: input.group_id,
        ...kcAuth(ctx),
      });
    },
  };
}

export function makeGroupsListMembersTool(
  deps: GroupsToolsDeps,
): Tool<GroupsListMembersInputT, { items: ReadonlyArray<GroupMember> }> {
  return {
    name: 'groups.list_members',
    description:
      'List active members of a group. Convenience wrapper around groups.get returning only the members slice.',
    sensitivity: 'read',
    inputSchema: GroupsListMembersInput,
    async execute(
      ctx: ToolContext,
      input,
    ): Promise<{ items: ReadonlyArray<GroupMember> }> {
      const { members } = await deps.knowledge.getGroup({
        userId: ctx.userId,
        groupId: input.group_id,
        ...kcAuth(ctx),
      });
      return { items: members };
    },
  };
}

export function makeGroupsArchiveTool(
  deps: GroupsToolsDeps,
): Tool<GroupsArchiveInputT, { ok: true }> {
  return {
    name: 'groups.archive',
    description:
      'Archive a group (owner-only, soft-delete). Existing share grants stay readable until explicitly revoked; new shares cannot target an archived group. Reversible via direct DB ops only.',
    sensitivity: 'write',
    displayTemplate:
      'Archive group {{group_id}} (soft-delete; existing shares remain readable until revoked).',
    inputSchema: GroupsArchiveInput,
    async execute(ctx: ToolContext, input): Promise<{ ok: true }> {
      await deps.knowledge.archiveGroup({
        userId: ctx.userId,
        groupId: input.group_id,
        ...kcAuth(ctx),
      });
      return { ok: true };
    },
  };
}

export function makeGroupsSetReadAuditTool(
  deps: GroupsToolsDeps,
): Tool<GroupsSetReadAuditInputT, { ok: true; enabled: boolean }> {
  return {
    name: 'groups.set_read_audit',
    description:
      'Toggle read-audit logging for a group (owner-only). When enabled, every member read on a group-shared object emits an audit event with the reader user-id. Useful for sensitive groups; off by default to minimise audit volume.',
    sensitivity: 'write',
    displayTemplate:
      'Set read-audit on group {{group_id}} to {{enabled}}.',
    inputSchema: GroupsSetReadAuditInput,
    async execute(
      ctx: ToolContext,
      input,
    ): Promise<{ ok: true; enabled: boolean }> {
      await deps.knowledge.setGroupReadAudit({
        userId: ctx.userId,
        groupId: input.group_id,
        enabled: input.enabled,
        ...kcAuth(ctx),
      });
      return { ok: true, enabled: input.enabled };
    },
  };
}

export function makeDocsShareWithGroupTool(
  deps: GroupsToolsDeps,
): Tool<DocsShareWithGroupInputT, GroupShare> {
  return {
    name: 'docs.share_with_group',
    description:
      'Share a single document with a group (read-only). NO auto-cascade — only this exact document is shared. For skill-bundle-sharing including all linked docs use skills.share_with_group.',
    sensitivity: 'write',
    displayTemplate:
      'Share document {{doc_id}} with group {{group_id}} (read-only, single-doc, no cascade).',
    inputSchema: DocsShareWithGroupInput,
    async execute(ctx: ToolContext, input): Promise<GroupShare> {
      return deps.knowledge.createShareWithGroup({
        userId: ctx.userId,
        resourceId: input.doc_id,
        groupId: input.group_id,
        scope: 'read',
        ...(input.expires_at !== undefined ? { expiresAt: input.expires_at } : {}),
        ...kcAuth(ctx),
      });
    },
  };
}

export function makeSharesRevokeTool(
  deps: GroupsToolsDeps,
): Tool<SharesRevokeInputT, { ok: true }> {
  return {
    name: 'shares.revoke',
    description:
      'Revoke a share grant (owner-only). Works for both user-grants and group-grants. Already-downloaded content cannot be recalled, but new reads via the revoked grant are blocked immediately. For group-grants the master-key is NOT rotated; only the specific grant row is marked revoked. Use groups.remove_member for a full key-rotation.',
    sensitivity: 'write',
    displayTemplate:
      'Revoke share {{share_id}} (blocks future reads; group master-key unchanged).',
    inputSchema: SharesRevokeInput,
    async execute(ctx: ToolContext, input): Promise<{ ok: true }> {
      await deps.knowledge.revokeShare({
        userId: ctx.userId,
        shareId: input.share_id,
        ...kcAuth(ctx),
      });
      return { ok: true };
    },
  };
}

export function makeSharesListMySharesTool(
  deps: GroupsToolsDeps,
): Tool<SharesListMySharesInputT, { items: ReadonlyArray<Share> }> {
  return {
    name: 'shares.list_my_shares',
    description:
      'List all shares granted TO the current user (inbound view) — either as direct user-grants or via group membership. Useful for "Shared with me" surfaces. Returns share rows, not the objects themselves; fetch resourceId via objects.read for body.',
    sensitivity: 'read',
    inputSchema: SharesListMySharesInput,
    async execute(ctx: ToolContext): Promise<{ items: ReadonlyArray<Share> }> {
      const items = await deps.knowledge.listSharedWithMe({
        userId: ctx.userId,
        ...kcAuth(ctx),
      });
      return { items };
    },
  };
}
