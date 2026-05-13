/**
 * credentials — Envelope-encrypted user-service-tokens (Jira/GitLab/Github/etc.).
 *
 * Plan-Ref: PLAN-architecture-v1.md §5 (Credentials & Crypto).
 *
 * Pattern (Envelope-Encryption):
 *   1. Random DEK pro Credential (AES-256-GCM key, 32 byte).
 *   2. DEK wird via OpenBao Transit-Engine "wrapped" → `wrapped_dek`. Pro User
 *      ein Transit-Key (`kek_ref = 'vault://transit/keys/user-{id}'`) damit
 *      User-Delete via Key-Destroy crypto-shreddet (§5.5).
 *   3. PRF-Layer (optional pro Credential, default TRUE): rawDek wird XOR-ed
 *      mit WebAuthn-PRF-Output zu effectiveDek. Damit kann das Plaintext nur
 *      decrypted werden, wenn User aktiv per Passkey approved hat.
 *   4. AES-GCM-Encrypt(plaintext, effectiveDek, nonce, aad) → `ciphertext`.
 *
 * Owner-only: KEINE Sharing-Grants auf dieser Tabelle (§4.3). RLS-Policy
 * enforct das, App-Layer-Helper `canAccess(user, action, credential)` als
 * Defense-in-Depth.
 *
 * UNIQUE(owner_id, provider, label): User kann mehrere Credentials pro
 * Provider haben ("work-jira" vs "side-project-jira"), aber Labels muessen
 * eindeutig sein.
 */
import {
  bigint,
  boolean,
  customType,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
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

/**
 * credentials-Tabelle.
 *
 * Spalten-Gruppen:
 *
 * Identity:
 * - `id`: UUID.
 * - `owner_id`: FK auf users(id). RLS filtert hier.
 * - `provider`: 'jira' | 'gitlab' | 'github' | 'google-workspace' | 'cloudflare' | ...
 * - `kind`: 'oauth_refresh' | 'api_token' | 'password' | 'service_account'.
 * - `label`: User-facing Name ("work-jira", "oss-github"). UNIQUE pro
 *   (owner, provider).
 *
 * Crypto-Material:
 * - `ciphertext`: AES-256-GCM ciphertext (incl. auth-tag in PG-BYTEA-Repr).
 * - `nonce`: 12-byte GCM nonce, per-encrypt zufaellig.
 * - `wrapped_dek`: Vault-Transit-encrypted DEK ("vault:v1:..." als BYTEA).
 * - `aad`: 'creds|{owner_id}|{provider}|{kind}|{id}' — verhindert cross-row
 *   ciphertext-swap.
 * - `kek_ref`: 'vault://transit/keys/user-{owner_id}' — fixiert welchen Key
 *   Vault zum Unwrap nutzen muss. Wird beim Crypto-Shredding gedestroyt.
 * - `alg`: Default 'A256GCM'. Reserved fuer Algorithmus-Migration.
 *
 * PRF-Layer:
 * - `prf_enabled`: Default TRUE. Wenn TRUE, ist ein PRF-Output beim Decrypt
 *   pflicht (sonst Error 'PRF_REQUIRED'). FALSE nur fuer Cron-Tools (§5.3).
 * - `prf_credential_id`: WebAuthn-credential.id, BYTEA. FK auf
 *   webauthn_credentials.prf_credential_id (lose, in SQL-Migration).
 *
 * Metadata (plaintext, nicht sensitive):
 * - `meta_json`: scopes, hostnames, OAuth-expiry-hint, etc.
 *
 * Lifecycle:
 * - `created_at` / `rotated_at` / `last_used_at` / `expires_at`.
 *
 * RLS-Policy (in 0001_initial.sql):
 *   CREATE POLICY owner_only_credentials ON credentials
 *     USING (owner_id = current_setting('app.current_user')::uuid);
 */
export const credentialsTable = pgTable(
  'credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull(),
    provider: text('provider').notNull(),
    kind: text('kind').notNull(), // 'oauth_refresh' | 'api_token' | 'password' | 'service_account'
    label: text('label').notNull(),

    ciphertext: bytea('ciphertext').notNull(),
    nonce: bytea('nonce').notNull(),
    wrappedDek: bytea('wrapped_dek').notNull(),
    aad: text('aad').notNull(),
    kekRef: text('kek_ref').notNull(),
    alg: text('alg').notNull().default('A256GCM'),

    prfEnabled: boolean('prf_enabled').notNull().default(true),
    prfCredentialId: bytea('prf_credential_id'),

    metaJson: jsonb('meta_json').$type<Record<string, unknown>>(),

    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    rotatedAt: bigint('rotated_at', { mode: 'number' }),
    lastUsedAt: bigint('last_used_at', { mode: 'number' }),
    expiresAt: bigint('expires_at', { mode: 'number' }),
  },
  (t) => ({
    ownerProviderLabelUnique: uniqueIndex('idx_credentials_owner_provider_label').on(
      t.ownerId,
      t.provider,
      t.label
    ),
    ownerIdx: index('idx_credentials_owner').on(t.ownerId),
    providerIdx: index('idx_credentials_provider').on(t.provider),
    expiresIdx: index('idx_credentials_expires').on(t.expiresAt),
  })
);
