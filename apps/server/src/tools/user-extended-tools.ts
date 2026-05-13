/**
 * Extended User-Tools — `user.get`, `user.set`.
 *
 * Plan-Ref: docs/plans/done/PLAN-prefs.md (mcp-approval) + Burst 3 (Settings).
 *
 * Diese Tools sind die schlanken DTO-Wrapper rund um den bestehenden
 * `user.profile.read` / `user.profile.update` Surface (apps/server/src/tools/
 * user-tools.ts). Wir machen NICHT denselben Pfad noch einmal — wir liefern
 * eine einfachere Sicht:
 *
 *   - `user.get` — gleicher Output wie `user.profile.read`, aber stripped
 *     auf {id, email, displayName, role} (kein status/createdAt etc.).
 *     Read-only.
 *
 *   - `user.set` — aktualisiert displayName ODER email. Approval-Gate
 *     (sensitivity='write', wie user.profile.update).
 *
 * Owner-only: `ctx.userId` ist die Identitaet; RLS stellt sicher dass kein
 * Cross-User-Zugriff moeglich ist.
 */
import { z } from 'zod';
import type { DbAdapter } from '@mcp-approval2/adapters';
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';
import { HttpError } from '../lib/errors.js';
import { getOwnProfile, type UserRow } from '../services/user.js';

export const UserGetInput = z.object({}).strict();
export type UserGetInputT = z.infer<typeof UserGetInput>;

export const UserSetInput = z
  .object({
    displayName: z.string().min(1).max(120).optional(),
    email: z.string().email().max(254).optional(),
  })
  .strict()
  .refine((v) => v.displayName !== undefined || v.email !== undefined, {
    message: 'at least one of displayName or email must be provided',
  });
export type UserSetInputT = z.infer<typeof UserSetInput>;

export interface UserMiniDto {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: 'admin' | 'member';
}

function toMini(row: UserRow): UserMiniDto {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
  };
}

export function makeUserGetTool(): Tool<UserGetInputT, UserMiniDto> {
  return {
    name: 'user.get',
    description: "Read the current user's profile bundle (id, email, displayName, role).",
    sensitivity: 'read',
    inputSchema: UserGetInput,
    async execute(ctx: ToolContext): Promise<UserMiniDto> {
      const row = await getOwnProfile(ctx.db, ctx.userId);
      return toMini(row);
    },
  };
}

export function makeUserSetTool(): Tool<UserSetInputT, UserMiniDto> {
  return {
    name: 'user.set',
    description:
      "Update profile fields (displayName, email). Requires approval (sensitivity=write).",
    sensitivity: 'write',
    displayTemplate: 'Update user profile: displayName={{displayName}}, email={{email}}',
    inputSchema: UserSetInput,
    async execute(ctx: ToolContext, input): Promise<UserMiniDto> {
      const row = await updateProfile(ctx.db, ctx.userId, input);
      return toMini(row);
    },
  };
}

async function updateProfile(
  db: DbAdapter,
  userId: string,
  patch: UserSetInputT,
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
