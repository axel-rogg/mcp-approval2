/**
 * webauthn_credentials — WebAuthn / Passkey-Layer mit PRF-Extension.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.4 (Passkey-Enrollment), §5.3 (PRF-Layer).
 *
 * Pattern:
 * - 1 Passkey pro User (User-Decision Bundle 1-6), Email-Magic-Link als
 *   Recovery-Fallback.
 * - PRF-Extension wird bei Enrollment angefordert: `extensions.prf.eval =
 *   { first: salt }`. PRF-Output wird WAEHREND Enrollment NICHT gespeichert,
 *   nur waehrend Login/Signing verfuegbar. Damit kann der Worker im
 *   Approval-Flow den PRF-Output XOR-en mit dem DEK (siehe credentials.ts).
 * - `prf_supported`: TRUE wenn der Authenticator PRF beim Register-Response
 *   bestaetigt hat. UI nutzt das fuer den Enrollment-Confirmation-Screen.
 */
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * BYTEA-Helper. Drizzle hat keinen Standard-bytea-Wrapper mit `Uint8Array`-
 * Mode out-of-the-box — wir definieren einen via customType, damit der TS-Typ
 * sauber `Uint8Array` ist statt `Buffer`.
 *
 * Driver-Erwartung: `postgres-js` liefert BYTEA als `Uint8Array` (ab v3.x).
 */
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
 * webauthn_credentials-Tabelle.
 *
 * - `credential_id`: WebAuthn-Spec credential.id, UNIQUE — wird beim
 *   Authentication-Request vom Client zurueckgegeben um den Server-Eintrag zu
 *   finden.
 * - `public_key`: COSE-encoded public-key bytes. Verification via @simplewebauthn/server
 *   oder eigener COSE-Parser.
 * - `sign_count`: WebAuthn-Spec counter. MUSS bei jedem Login monoton steigen
 *   (Clone-Detection). Wenn das nicht der Fall ist: Authenticator wurde geklont
 *   → Credential markieren + Audit-Log.
 * - `transports`: JSON-Array von Hint-Werten ('usb', 'nfc', 'ble', 'internal',
 *   'hybrid'). Wird bei allowCredentials-Listen verwendet.
 * - `prf_supported`: aus Register-Response. TRUE wenn `extensions.prf.results
 *   .first` waehrend Enrollment present war.
 * - `prf_credential_id`: WebAuthn-credential-id als BYTEA, dupliziert um es
 *   FK-fuehig zu machen (credentials.prf_credential_id referenziert das).
 *   Ist effektiv == credential_id, separate Spalte fuer Klarheit.
 * - `friendly_name`: User-Setting "Mein YubiKey" / "iPhone Touch-ID". NULL-able.
 *
 * Drizzle-FK auf users(id) wird in der SQL-Migration gesetzt (ON DELETE CASCADE
 * fuer User-Erase-Flow, §5.5 Crypto-Shredding).
 */
export const webauthnCredentialsTable = pgTable(
  'webauthn_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    credentialId: bytea('credential_id').notNull(),
    publicKey: bytea('public_key').notNull(),
    signCount: integer('sign_count').notNull().default(0),
    transports: jsonb('transports').$type<string[]>().default([]),
    prfSupported: boolean('prf_supported').notNull().default(false),
    prfCredentialId: bytea('prf_credential_id'),
    friendlyName: text('friendly_name'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastUsedAt: bigint('last_used_at', { mode: 'number' }),
    // Recovery-Marker: wenn User Passkey verloren hat und neuen enrolled,
    // wird die alte Row hier mit Timestamp markiert (siehe §3.4 Recovery).
    invalidatedAt: bigint('invalidated_at', { mode: 'number' }),
  },
  (t) => ({
    credentialIdUnique: uniqueIndex('idx_webauthn_credential_id').on(t.credentialId),
    userIdx: index('idx_webauthn_user').on(t.userId),
  })
);
