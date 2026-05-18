/**
 * ToolDefaultProfilesService — CRUD fuer Per-User-Per-Server Profile.
 *
 * Plan-Ref: docs/plans/active/PLAN-tool-defaults-v2.md (Phase C).
 * Tabelle: user_tool_default_profiles (Mig 0028).
 *
 * Konzept (Plan §2.2):
 *   Pro (user × sub_mcp_name) gibt es N Profile mit eindeutigem
 *   `profile_name`. Genau EINES davon ist `is_active=TRUE` (partial-unique-
 *   Index in 0028). Profile sind reine Container — die Defaults selbst
 *   liegen in `user_server_tool_defaults` mit `profile_name`-Diskriminator.
 *
 * Per-User-Isolation (Plan §8):
 *   - PK enthaelt `user_id` → Profile-Names kollidieren pro User unabhaengig.
 *   - db.transaction(userId, ...) setzt app.current_user → RLS owner-only.
 *   - Active-Profile-Flag ist (user, sub_mcp_name)-skopiert.
 *
 * Beispiel-Use-Case:
 *   Alice hat 'prod' (active) + 'test' auf sub_mcp_name='db'. Bob hat
 *   eigenes 'prod' (active) auf 'db' — kollisionsfrei via PK.
 */
import type { DbAdapter } from '@mcp-approval2/adapters';
import { HttpError } from '../lib/errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolDefaultProfile {
  readonly userId: string;
  readonly subMcpName: string;
  readonly profileName: string;
  readonly description: string;
  readonly isActive: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateProfileArgs {
  readonly userId: string;
  readonly subMcpName: string;
  readonly profileName: string;
  readonly description?: string;
  /**
   * Optional: kopiert alle `user_server_tool_defaults`-Rows aus dem
   * `copyFrom`-Profil in das neue Profil. Wirft 404 wenn `copyFrom`
   * nicht existiert.
   */
  readonly copyFrom?: string;
  /** Default: das neue Profil ist NICHT aktiv. Caller ruft `activate()` separat. */
  readonly activate?: boolean;
}

export interface ToolDefaultProfilesService {
  /** Liefert alle Profile fuer (user, sub_mcp_name). Sortiert alphabetisch. */
  list(userId: string, subMcpName: string): Promise<ReadonlyArray<ToolDefaultProfile>>;
  /** Returnt das eine aktive Profil oder `null` wenn (User, Server) leer. */
  getActive(userId: string, subMcpName: string): Promise<ToolDefaultProfile | null>;
  /**
   * Active-Profile-Resolution mit Fallback. Returnt:
   *   - `is_active=TRUE` Profil falls vorhanden
   *   - `'default'` als String falls kein Profil existiert
   *
   * Wird vom Resolver aufgerufen (lazy seed durch Mig 0028 + set()-Pfad).
   */
  activeProfileNameFor(userId: string, subMcpName: string): Promise<string>;
  /** Existenz-Check (z.B. fuer __profile-Override-Validierung). */
  exists(userId: string, subMcpName: string, profileName: string): Promise<boolean>;
  /** Create. Wirft 409 bei Name-Konflikt. Optional aktiviert nach Create. */
  create(args: CreateProfileArgs): Promise<ToolDefaultProfile>;
  /**
   * Aktiviert `profileName` — flip-flop atomar in einer TX. Setzt alle
   * anderen Profile fuer (user, sub_mcp_name) auf is_active=FALSE und
   * dieses auf TRUE. Wirft 404 wenn das Profil nicht existiert.
   */
  activate(userId: string, subMcpName: string, profileName: string): Promise<void>;
  /**
   * Loescht ein Profil + alle zugehoerigen tool-defaults-Rows.
   * Wirft 409 wenn das Profil aktiv ist ('default' aktivieren vorher).
   */
  delete(userId: string, subMcpName: string, profileName: string): Promise<void>;
}

interface RawProfileRow {
  readonly user_id: string;
  readonly sub_mcp_name: string;
  readonly profile_name: string;
  readonly description: string;
  readonly is_active: boolean;
  readonly created_at: number | string;
  readonly updated_at: number | string;
}

function toNumber(v: number | string): number {
  return typeof v === 'number' ? v : Number(v);
}

function rowToProfile(r: RawProfileRow): ToolDefaultProfile {
  return {
    userId: r.user_id,
    subMcpName: r.sub_mcp_name,
    profileName: r.profile_name,
    description: r.description,
    isActive: r.is_active,
    createdAt: toNumber(r.created_at),
    updatedAt: toNumber(r.updated_at),
  };
}

const PROFILE_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function assertProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw HttpError.badRequest(
      'invalid_request',
      `profile name '${name}' is not a valid slug (a-z 0-9 _ -, max 64 chars)`,
    );
  }
}

const SELECT_COLS = `
  user_id, sub_mcp_name, profile_name, description, is_active,
  created_at, updated_at
`;

// ---------------------------------------------------------------------------
// Service-Factory
// ---------------------------------------------------------------------------

export interface ToolDefaultProfilesServiceOpts {
  readonly db: DbAdapter;
  readonly now?: () => number;
}

export function createToolDefaultProfilesService(
  opts: ToolDefaultProfilesServiceOpts,
): ToolDefaultProfilesService {
  const { db } = opts;
  const now = opts.now ?? (() => Date.now());

  return {
    async list(userId, subMcpName) {
      return await db.transaction(userId, async (scoped) => {
        const rows = await scoped.query<RawProfileRow>(
          `SELECT ${SELECT_COLS}
             FROM user_tool_default_profiles
            WHERE user_id = $1 AND sub_mcp_name = $2
            ORDER BY profile_name ASC`,
          [userId, subMcpName],
        );
        return rows.map(rowToProfile);
      });
    },

    async getActive(userId, subMcpName) {
      return await db.transaction(userId, async (scoped) => {
        const rows = await scoped.query<RawProfileRow>(
          `SELECT ${SELECT_COLS}
             FROM user_tool_default_profiles
            WHERE user_id = $1 AND sub_mcp_name = $2 AND is_active = TRUE
            LIMIT 1`,
          [userId, subMcpName],
        );
        return rows[0] ? rowToProfile(rows[0]) : null;
      });
    },

    async activeProfileNameFor(userId, subMcpName) {
      const active = await this.getActive(userId, subMcpName);
      return active?.profileName ?? 'default';
    },

    async exists(userId, subMcpName, profileName) {
      return await db.transaction(userId, async (scoped) => {
        const rows = await scoped.query<{ exists: boolean }>(
          `SELECT 1 AS exists
             FROM user_tool_default_profiles
            WHERE user_id = $1 AND sub_mcp_name = $2 AND profile_name = $3
            LIMIT 1`,
          [userId, subMcpName, profileName],
        );
        return rows.length > 0;
      });
    },

    async create(args) {
      assertProfileName(args.profileName);
      const description = args.description ?? '';
      const ts = now();
      const copyFrom = args.copyFrom;
      if (copyFrom !== undefined) {
        assertProfileName(copyFrom);
      }

      return await db.transaction(args.userId, async (scoped) => {
        // 1. Check Name-Konflikt + copyFrom-Existenz innerhalb der TX.
        const existing = await scoped.query<{ profile_name: string }>(
          `SELECT profile_name
             FROM user_tool_default_profiles
            WHERE user_id = $1 AND sub_mcp_name = $2 AND profile_name = $3
            LIMIT 1`,
          [args.userId, args.subMcpName, args.profileName],
        );
        if (existing.length > 0) {
          throw HttpError.conflict(
            `profile '${args.profileName}' already exists for server '${args.subMcpName}'`,
            { code: 'profile_exists' },
          );
        }
        if (copyFrom) {
          const src = await scoped.query<{ profile_name: string }>(
            `SELECT profile_name
               FROM user_tool_default_profiles
              WHERE user_id = $1 AND sub_mcp_name = $2 AND profile_name = $3
              LIMIT 1`,
            [args.userId, args.subMcpName, copyFrom],
          );
          if (src.length === 0) {
            throw HttpError.notFound(
              `copyFrom profile '${copyFrom}' does not exist`,
            );
          }
        }

        // 2. Insert Profil-Row.
        const profileRows = await scoped.query<RawProfileRow>(
          `INSERT INTO user_tool_default_profiles
             (user_id, sub_mcp_name, profile_name, description, is_active,
              created_at, updated_at)
           VALUES ($1, $2, $3, $4, FALSE, $5, $5)
           RETURNING ${SELECT_COLS}`,
          [args.userId, args.subMcpName, args.profileName, description, ts],
        );
        const row = profileRows[0];
        if (!row) throw new Error('profile insert returned no row');

        // 3. Optional: copyFrom — duplizier alle defaults-Rows mit neuem
        //    profile_name. Idempotent: ON CONFLICT DO NOTHING (sollte nicht
        //    feuern, weil das neue Profil leer angelegt wurde).
        if (copyFrom) {
          await scoped.query(
            `INSERT INTO user_server_tool_defaults
               (user_id, sub_mcp_name, profile_name, tool_name, field_name,
                value_text, value_json, value_kind, is_secret,
                orphan_since, created_at, updated_at)
             SELECT user_id, sub_mcp_name, $4 AS profile_name, tool_name, field_name,
                    value_text, value_json, value_kind, is_secret,
                    NULL AS orphan_since, $5 AS created_at, $5 AS updated_at
               FROM user_server_tool_defaults
              WHERE user_id = $1 AND sub_mcp_name = $2 AND profile_name = $3
             ON CONFLICT (user_id, sub_mcp_name, profile_name, tool_name, field_name)
             DO NOTHING`,
            [args.userId, args.subMcpName, copyFrom, args.profileName, ts],
          );
        }

        // 4. Optional: aktivieren — flip-flop in derselben TX.
        if (args.activate) {
          await scoped.query(
            `UPDATE user_tool_default_profiles
                SET is_active = FALSE, updated_at = $1
              WHERE user_id = $2 AND sub_mcp_name = $3 AND is_active = TRUE`,
            [ts, args.userId, args.subMcpName],
          );
          await scoped.query(
            `UPDATE user_tool_default_profiles
                SET is_active = TRUE, updated_at = $1
              WHERE user_id = $2 AND sub_mcp_name = $3 AND profile_name = $4`,
            [ts, args.userId, args.subMcpName, args.profileName],
          );
          return rowToProfile({ ...row, is_active: true, updated_at: ts });
        }
        return rowToProfile(row);
      });
    },

    async activate(userId, subMcpName, profileName) {
      assertProfileName(profileName);
      const ts = now();
      await db.transaction(userId, async (scoped) => {
        // Existenz-Check in der TX (sonst Race: Profile koennten gleichzeitig
        // gedroppt werden).
        const exists = await scoped.query<{ profile_name: string }>(
          `SELECT profile_name
             FROM user_tool_default_profiles
            WHERE user_id = $1 AND sub_mcp_name = $2 AND profile_name = $3
            LIMIT 1`,
          [userId, subMcpName, profileName],
        );
        if (exists.length === 0) {
          throw HttpError.notFound(
            `profile '${profileName}' does not exist for server '${subMcpName}'`,
          );
        }
        // Atomar in der TX: alle aus, dann das eine an.
        await scoped.query(
          `UPDATE user_tool_default_profiles
              SET is_active = FALSE, updated_at = $1
            WHERE user_id = $2 AND sub_mcp_name = $3 AND is_active = TRUE`,
          [ts, userId, subMcpName],
        );
        await scoped.query(
          `UPDATE user_tool_default_profiles
              SET is_active = TRUE, updated_at = $1
            WHERE user_id = $2 AND sub_mcp_name = $3 AND profile_name = $4`,
          [ts, userId, subMcpName, profileName],
        );
      });
    },

    async delete(userId, subMcpName, profileName) {
      assertProfileName(profileName);
      await db.transaction(userId, async (scoped) => {
        const row = await scoped.query<{ is_active: boolean }>(
          `SELECT is_active
             FROM user_tool_default_profiles
            WHERE user_id = $1 AND sub_mcp_name = $2 AND profile_name = $3
            LIMIT 1`,
          [userId, subMcpName, profileName],
        );
        if (row.length === 0) {
          throw HttpError.notFound(
            `profile '${profileName}' does not exist for server '${subMcpName}'`,
          );
        }
        if (row[0]?.is_active) {
          throw HttpError.conflict(
            `cannot delete active profile '${profileName}' — activate another profile first`,
            { code: 'profile_active' },
          );
        }
        // 1. Erst die zugehoerigen tool-defaults-Rows raeumen.
        await scoped.query(
          `DELETE FROM user_server_tool_defaults
            WHERE user_id = $1 AND sub_mcp_name = $2 AND profile_name = $3`,
          [userId, subMcpName, profileName],
        );
        // 2. Dann die Profil-Row.
        await scoped.query(
          `DELETE FROM user_tool_default_profiles
            WHERE user_id = $1 AND sub_mcp_name = $2 AND profile_name = $3`,
          [userId, subMcpName, profileName],
        );
      });
    },
  };
}
