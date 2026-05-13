/**
 * user_prefs — pro-User-Tool-Defaults + Profiles + Hints, AES-GCM-verschluesselt.
 *
 * Plan-Ref: docs/plans/done/PLAN-prefs.md (mcp-approval) + §7 Burst 3 hier.
 *
 * Schema:
 *   - PK = user_id (eine Row pro User; FK CASCADE on users-delete)
 *   - ciphertext + nonce + wrapped_dek + aad + kek_ref — Envelope-Encryption
 *     wie credentials, AAD-Pattern 'prefs|{user_id}'.
 *   - alg default A256GCM, version (Schema-Version) default 1.
 *
 * RLS: 'user_prefs_owner' Policy in 0008_prefs.sql.
 */
import {
  bigint,
  customType,
  integer,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return 'bytea';
  },
  fromDriver(value: Uint8Array) {
    return value;
  },
  toDriver(value: Uint8Array) {
    return value;
  },
});

export const userPrefsTable = pgTable('user_prefs', {
  userId: uuid('user_id').primaryKey(),

  ciphertext: bytea('ciphertext').notNull(),
  nonce: bytea('nonce').notNull(),
  wrappedDek: bytea('wrapped_dek').notNull(),
  aad: text('aad').notNull(),
  kekRef: text('kek_ref').notNull(),
  alg: text('alg').notNull().default('A256GCM'),

  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  version: integer('version').notNull().default(1),
});
