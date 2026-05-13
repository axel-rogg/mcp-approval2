/**
 * User-Tools — Profile-Read/Update.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.1 (User-Model), §11 Burst 3.
 *
 * `user.profile.read`  — Read-only, dispatch sofort ausfuehrbar.
 * `user.profile.update` — Write-Tool, geht durch Approval-Gate (PWA-Confirm
 *                         via WYSIWYS-Display).
 *
 * Beide Tools nutzen `ctx.userId` als Identitaet — der Caller (Auth-Middleware)
 * MUSS diesen Wert korrekt setzen. RLS in der DB stellt zusaetzlich sicher,
 * dass kein Cross-User-Zugriff moeglich ist.
 */
import type { DbAdapter } from '@mcp-approval2/adapters';
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';
import { HttpError } from '../lib/errors.js';
import { getOwnProfile, type UserRow } from '../services/user.js';
import {
  UserProfileReadInput,
  UserProfileUpdateInput,
  type UserProfileReadInput as UserProfileReadInputT,
  type UserProfileUpdateInput as UserProfileUpdateInputT,
} from './types.js';

export interface UserProfileDto {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: 'admin' | 'member';
  readonly status: 'active' | 'invited' | 'suspended' | 'deleted';
  readonly createdAt: number;
  readonly lastLoginAt: number | null;
}

function toDto(row: UserRow): UserProfileDto {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
  };
}

export function makeUserProfileReadTool(): Tool<UserProfileReadInputT, UserProfileDto> {
  return {
    name: 'user.profile.read',
    description: "Read the current user's profile (id, email, displayName, role, status).",
    sensitivity: 'read',
    inputSchema: UserProfileReadInput,
    async execute(ctx: ToolContext): Promise<UserProfileDto> {
      const row = await getOwnProfile(ctx.db, ctx.userId);
      return toDto(row);
    },
  };
}

export function makeUserProfileUpdateTool(): Tool<UserProfileUpdateInputT, UserProfileDto> {
  return {
    name: 'user.profile.update',
    description:
      "Update the current user's profile fields (displayName, email). Requires approval.",
    sensitivity: 'write',
    displayTemplate:
      'Update profile fields: {{displayName}} / {{email}}',
    inputSchema: UserProfileUpdateInput,
    async execute(ctx: ToolContext, input): Promise<UserProfileDto> {
      const row = await updateOwnProfile(ctx.db, ctx.userId, input);
      return toDto(row);
    },
  };
}

/**
 * Update-Helper. Wir leben mit zwei separaten SETs (displayName, email), damit
 * das SQL trivial bleibt — bei mehr Feldern dann auf einen dynamischen Builder
 * umstellen.
 */
async function updateOwnProfile(
  db: DbAdapter,
  userId: string,
  patch: UserProfileUpdateInputT,
): Promise<UserRow> {
  const scoped = await db.scoped(userId);

  if (patch.displayName !== undefined) {
    await scoped.query(`UPDATE users SET display_name = $1 WHERE id = $2`, [
      patch.displayName,
      userId,
    ]);
  }
  if (patch.email !== undefined) {
    await scoped.query(`UPDATE users SET email = $1 WHERE id = $2`, [
      patch.email.toLowerCase(),
      userId,
    ]);
  }

  const rows = await scoped.query<UserRow>(
    `SELECT id, external_id AS "externalId", email, display_name AS "displayName",
            role, status, created_at AS "createdAt", last_login_at AS "lastLoginAt",
            invited_by AS "invitedBy", deleted_at AS "deletedAt"
       FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const row = rows[0];
  if (!row) throw HttpError.notFound('user not found');
  return row;
}
