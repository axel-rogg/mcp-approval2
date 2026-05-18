/**
 * Group-Sharing Tool-Surface (Phase 1, Item 6e).
 *
 * Plan-Ref: docs/plans/active/PLAN-sharing-group-phase-1.md §8 (KC2-Plan)
 *           + cross-repo ADR-0024 in mcp-approval2/docs/adr/
 *
 * Kern-Tools (5, statt aller 12 — Rest in Phase 2):
 *   - groups.create         (write — User-initiated, Auto-Bypass im Write-Mode)
 *   - groups.list           (read)
 *   - groups.add_member     (write mit displayTemplate-Warning)
 *   - groups.remove_member  (write — owner-only, triggert Master-Rotation)
 *   - skills.share_with_group (write — Lazy-Migration + Bundle-Cascade)
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
      'Share a skill (and all linked skill_resource documents via auto-cascade) with a group. All group members will be able to read the skill + its bundled documents. Use shares.revoke (Phase 2) to undo.',
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
