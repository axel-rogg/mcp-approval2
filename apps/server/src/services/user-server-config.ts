/**
 * UserServerConfigService — per-User pro-Server Config-Werte (KMS-encrypted).
 *
 * Plan-Ref: docs/plans/active/PLAN-per-user-server-store.md (Phase 2).
 *
 * Pattern uebernommen aus services/credentials.ts:
 *   1. Generate raw-DEK (32 bytes) per Config-Eintrag
 *   2. AES-GCM-Encrypt value mit DEK + AAD (recordType='generic',
 *      namespace='user_sub_mcp_config', id='<userId>|<server>|<key>')
 *   3. Wrap DEK mit user-KEK via kekProvider
 *   4. Persist {wrapped_dek, kek_ref, ciphertext, nonce, is_secret}
 *
 * Konvention: `config_key` startet mit `_` wenn secret (z.B. `_bearer_token`,
 * `_oauth_refresh_token`, `_oauth_client_secret`). UI rendert anders
 * (masked-display + password-input). Auch non-secret-Werte werden encrypted
 * — Konsistenz + spaetere Re-Klassifizierung.
 */
import type { DbAdapter, KekProvider } from '@mcp-approval2/adapters';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  buildAad,
  randomBytes,
} from '@mcp-approval2/core';
import { HttpError } from '../lib/errors.js';
import { emitAudit } from './audit.js';

export interface UserServerConfigEntry {
  readonly userId: string;
  readonly subMcpName: string;
  readonly configKey: string;
  readonly isSecret: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface UserServerConfigEntryWithValue extends UserServerConfigEntry {
  readonly value: string;
}

export interface UserServerConfigService {
  /** Liste aller Configs fuer einen User+Server (keys + metadata; ohne values). */
  listKeys(userId: string, subMcpName: string): Promise<ReadonlyArray<UserServerConfigEntry>>;
  /** Single config-Eintrag inkl. decrypted value. Throws wenn nicht gefunden. */
  get(userId: string, subMcpName: string, configKey: string): Promise<UserServerConfigEntryWithValue>;
  /** Alle Configs fuer User+Server als plain map (decrypted). Fuer Forwarder. */
  getAllValues(userId: string, subMcpName: string): Promise<Map<string, string>>;
  /** Upsert: encryptet value, persistiert. is_secret auto-derived aus `_`-Prefix. */
  set(userId: string, subMcpName: string, configKey: string, value: string): Promise<UserServerConfigEntry>;
  /** Loescht einen Eintrag. */
  delete(userId: string, subMcpName: string, configKey: string): Promise<void>;
  /** Loescht alle Configs fuer User+Server (z.B. bei Unsubscribe). */
  deleteAllForServer(userId: string, subMcpName: string): Promise<void>;
}

interface RawRow {
  readonly user_id: string;
  readonly sub_mcp_name: string;
  readonly config_key: string;
  readonly wrapped_dek: Uint8Array;
  readonly kek_ref: string;
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly is_secret: boolean;
  readonly created_at: number | string;
  readonly updated_at: number | string;
}

function toNumber(v: number | string): number {
  return typeof v === 'number' ? v : Number(v);
}

function isSecretKey(key: string): boolean {
  return key.startsWith('_');
}

function rowToEntry(r: RawRow): UserServerConfigEntry {
  return {
    userId: r.user_id,
    subMcpName: r.sub_mcp_name,
    configKey: r.config_key,
    isSecret: r.is_secret,
    createdAt: toNumber(r.created_at),
    updatedAt: toNumber(r.updated_at),
  };
}

export interface UserServerConfigServiceOpts {
  readonly db: DbAdapter;
  readonly kekProvider: KekProvider;
  readonly kekRef?: string;
  readonly now?: () => number;
}

export function createUserServerConfigService(
  opts: UserServerConfigServiceOpts,
): UserServerConfigService {
  const { db, kekProvider } = opts;
  const kekRef = opts.kekRef ?? 'default';
  const now = opts.now ?? (() => Date.now());
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function aadFor(userId: string, subMcpName: string, configKey: string): string {
    return buildAad({
      recordType: 'generic',
      namespace: 'user_sub_mcp_config',
      id: `${userId}|${subMcpName}|${configKey}`,
    });
  }

  async function decryptRow(row: RawRow): Promise<string> {
    const rawDek = await kekProvider.unwrap(row.wrapped_dek, row.kek_ref);
    try {
      const plaintext = await aesGcmDecrypt({
        key: rawDek,
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        aad: aadFor(row.user_id, row.sub_mcp_name, row.config_key),
      });
      return dec.decode(plaintext);
    } finally {
      rawDek.fill(0);
    }
  }

  const SELECT_COLS = `
    user_id, sub_mcp_name, config_key,
    wrapped_dek, kek_ref, ciphertext, nonce,
    is_secret, created_at, updated_at
  `;

  // ⚠️ Connection-Pool: ALLE Methoden nutzen db.transaction() statt
  // db.scoped() — letzteres reserved eine Connection ohne release() und
  // exhaustet den Postgres-Pool. Siehe user-subscriptions.ts.
  return {
    async listKeys(userId, subMcpName) {
      return await db.transaction(userId, async (scoped) => {
        const rows = await scoped.query<RawRow>(
          `SELECT ${SELECT_COLS} FROM user_sub_mcp_config
            WHERE user_id = $1 AND sub_mcp_name = $2
            ORDER BY config_key ASC`,
          [userId, subMcpName],
        );
        return rows.map(rowToEntry);
      });
    },

    async get(userId, subMcpName, configKey) {
      return await db.transaction(userId, async (scoped) => {
        const rows = await scoped.query<RawRow>(
          `SELECT ${SELECT_COLS} FROM user_sub_mcp_config
            WHERE user_id = $1 AND sub_mcp_name = $2 AND config_key = $3
            LIMIT 1`,
          [userId, subMcpName, configKey],
        );
        const row = rows[0];
        if (!row) throw HttpError.notFound('config key not found');
        const value = await decryptRow(row);
        return { ...rowToEntry(row), value };
      });
    },

    async getAllValues(userId, subMcpName) {
      return await db.transaction(userId, async (scoped) => {
        const rows = await scoped.query<RawRow>(
          `SELECT ${SELECT_COLS} FROM user_sub_mcp_config
            WHERE user_id = $1 AND sub_mcp_name = $2`,
          [userId, subMcpName],
        );
        const map = new Map<string, string>();
        for (const r of rows) {
          const v = await decryptRow(r);
          map.set(r.config_key, v);
        }
        return map;
      });
    },

    async set(userId, subMcpName, configKey, value) {
      const rawDek = randomBytes(32);
      try {
        const aad = aadFor(userId, subMcpName, configKey);
        const { ciphertext, nonce } = await aesGcmEncrypt({
          key: rawDek,
          plaintext: enc.encode(value),
          aad,
        });
        const wrappedDek = await kekProvider.wrap(rawDek, kekRef);
        const ts = now();
        const isSecret = isSecretKey(configKey);

        const row = await db.transaction(userId, async (scoped) => {
          const rows = await scoped.query<RawRow>(
            `INSERT INTO user_sub_mcp_config
               (user_id, sub_mcp_name, config_key,
                wrapped_dek, kek_ref, ciphertext, nonce,
                is_secret, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
             ON CONFLICT (user_id, sub_mcp_name, config_key) DO UPDATE
               SET wrapped_dek = EXCLUDED.wrapped_dek,
                   kek_ref     = EXCLUDED.kek_ref,
                   ciphertext  = EXCLUDED.ciphertext,
                   nonce       = EXCLUDED.nonce,
                   is_secret   = EXCLUDED.is_secret,
                   updated_at  = EXCLUDED.updated_at
             RETURNING ${SELECT_COLS}`,
            [userId, subMcpName, configKey, wrappedDek, kekRef, ciphertext, nonce, isSecret, ts],
          );
          return rows[0];
        });
        if (!row) throw new HttpError(500, 'internal', 'config upsert returned no row');

        await emitAudit(db, {
          action: 'user_server_config.set',
          actorUserId: userId,
          result: 'success',
          details: { sub_mcp_name: subMcpName, config_key: configKey, is_secret: isSecret },
        });

        return rowToEntry(row);
      } finally {
        rawDek.fill(0);
      }
    },

    async delete(userId, subMcpName, configKey) {
      const deleted = await db.transaction(userId, async (scoped) => {
        const result = await scoped.query<{ deleted: number }>(
          `WITH del AS (
            DELETE FROM user_sub_mcp_config
             WHERE user_id = $1 AND sub_mcp_name = $2 AND config_key = $3
            RETURNING 1
          ) SELECT COUNT(*)::int AS deleted FROM del`,
          [userId, subMcpName, configKey],
        );
        return result[0]?.deleted ?? 0;
      });
      if (deleted === 0) {
        throw HttpError.notFound('config key not found');
      }
      await emitAudit(db, {
        action: 'user_server_config.delete',
        actorUserId: userId,
        result: 'success',
        details: { sub_mcp_name: subMcpName, config_key: configKey },
      });
    },

    async deleteAllForServer(userId, subMcpName) {
      await db.transaction(userId, async (scoped) => {
        await scoped.query(
          `DELETE FROM user_sub_mcp_config
            WHERE user_id = $1 AND sub_mcp_name = $2`,
          [userId, subMcpName],
        );
      });
      await emitAudit(db, {
        action: 'user_server_config.delete_all',
        actorUserId: userId,
        result: 'success',
        details: { sub_mcp_name: subMcpName },
      });
    },
  };
}
