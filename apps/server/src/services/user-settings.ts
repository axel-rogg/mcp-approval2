/**
 * UserSettingsService — key/value-Store fuer Per-User-Agent-Settings.
 *
 * Plan-Ref: docs/plans/active/PLAN-tool-defaults-v2.md (Phase E).
 * Tabelle: user_settings (Mig 0029).
 *
 * Heute genutzt fuer:
 *   - `elicit_on_missing_defaults` (boolean, default FALSE — Plan §10 Entscheidung ②)
 *
 * Per-User-Isolation: PK (user_id, key) + RLS owner-only.
 */
import type { DbAdapter } from '@mcp-approval2/adapters';
import { HttpError } from '../lib/errors.js';

const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UserSettingEntry {
  readonly userId: string;
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt: number;
}

export interface UserSettingsService {
  /** Liefert alle Settings eines Users (PWA-Tab). */
  list(userId: string): Promise<ReadonlyArray<UserSettingEntry>>;
  /** Get einzelnes Setting; `null` wenn nicht gesetzt. */
  get(userId: string, key: string): Promise<UserSettingEntry | null>;
  /** Typed-Read mit Default-Fallback (fuer Service-Code). */
  getBoolean(userId: string, key: string, fallback: boolean): Promise<boolean>;
  /** Upsert. */
  set(userId: string, key: string, value: unknown): Promise<UserSettingEntry>;
  /** Remove. */
  remove(userId: string, key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------------

/**
 * Setting-Key fuer Plan-Entscheidung ②: Elicit-On-Missing-Defaults.
 * Default FALSE damit Family-Mode-User keinen "wo kommt diese Form her"-
 * Effekt erleben. Plan §10 §2.
 */
export const SETTING_ELICIT_ON_MISSING_DEFAULTS = 'elicit_on_missing_defaults';

// ---------------------------------------------------------------------------
// Row-mapping
// ---------------------------------------------------------------------------

interface RawSettingRow {
  readonly user_id: string;
  readonly key: string;
  readonly value: unknown;
  readonly updated_at: number | string;
}

function toNumber(v: number | string): number {
  return typeof v === 'number' ? v : Number(v);
}

function rowToEntry(r: RawSettingRow): UserSettingEntry {
  return {
    userId: r.user_id,
    key: r.key,
    value: r.value,
    updatedAt: toNumber(r.updated_at),
  };
}

const SELECT_COLS = `user_id, key, value, updated_at`;

function assertKey(key: string): void {
  if (!KEY_RE.test(key)) {
    throw HttpError.badRequest(
      'invalid_request',
      `setting key '${key}' is not a valid slug (a-z 0-9 _, max 64 chars)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface UserSettingsServiceOpts {
  readonly db: DbAdapter;
  readonly now?: () => number;
}

export function createUserSettingsService(
  opts: UserSettingsServiceOpts,
): UserSettingsService {
  const { db } = opts;
  const now = opts.now ?? (() => Date.now());

  return {
    async list(userId) {
      return await db.transaction(userId, async (scoped) => {
        const rows = await scoped.query<RawSettingRow>(
          `SELECT ${SELECT_COLS}
             FROM user_settings
            WHERE user_id = $1
            ORDER BY key ASC`,
          [userId],
        );
        return rows.map(rowToEntry);
      });
    },

    async get(userId, key) {
      assertKey(key);
      return await db.transaction(userId, async (scoped) => {
        const rows = await scoped.query<RawSettingRow>(
          `SELECT ${SELECT_COLS}
             FROM user_settings
            WHERE user_id = $1 AND key = $2
            LIMIT 1`,
          [userId, key],
        );
        const row = rows[0];
        return row ? rowToEntry(row) : null;
      });
    },

    async getBoolean(userId, key, fallback) {
      const entry = await this.get(userId, key);
      if (entry === null) return fallback;
      if (typeof entry.value === 'boolean') return entry.value;
      return fallback;
    },

    async set(userId, key, value) {
      assertKey(key);
      const ts = now();
      const row = await db.transaction(userId, async (scoped) => {
        const rows = await scoped.query<RawSettingRow>(
          `INSERT INTO user_settings (user_id, key, value, updated_at)
           VALUES ($1, $2, $3::jsonb, $4)
           ON CONFLICT (user_id, key) DO UPDATE
             SET value      = EXCLUDED.value,
                 updated_at = EXCLUDED.updated_at
           RETURNING ${SELECT_COLS}`,
          [userId, key, JSON.stringify(value), ts],
        );
        return rows[0];
      });
      if (!row) throw new Error('user_settings upsert returned no row');
      return rowToEntry(row);
    },

    async remove(userId, key) {
      assertKey(key);
      await db.transaction(userId, async (scoped) => {
        await scoped.query(
          `DELETE FROM user_settings WHERE user_id = $1 AND key = $2`,
          [userId, key],
        );
      });
    },
  };
}
