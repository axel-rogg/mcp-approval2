/**
 * Drizzle-inferred Types — Single-Import-Point fuer Application-Code.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3, §5, §6.
 *
 * Pattern: pro Tabelle `Type` (= Select-Row) + `NewType` (= Insert-Row).
 * Drizzle generiert die Typen aus dem Schema mit `$inferSelect` / `$inferInsert`,
 * inklusive Nullability + Defaults.
 *
 * Application-Code soll NUR diese Typen importieren, nicht die Tabellen-
 * Objekte (die sind nur fuer Drizzle-Query-Builder-Use).
 */
import type {
  auditLogTable,
  credentialsTable,
  invitesTable,
  refreshTokensTable,
  revokedJtisTable,
  sessionsTable,
  usersTable,
  webauthnCredentialsTable,
} from './postgres/index.js';

// users
export type User = typeof usersTable.$inferSelect;
export type NewUser = typeof usersTable.$inferInsert;

// invites
export type Invite = typeof invitesTable.$inferSelect;
export type NewInvite = typeof invitesTable.$inferInsert;

// sessions
export type Session = typeof sessionsTable.$inferSelect;
export type NewSession = typeof sessionsTable.$inferInsert;

// refresh_tokens
export type RefreshToken = typeof refreshTokensTable.$inferSelect;
export type NewRefreshToken = typeof refreshTokensTable.$inferInsert;

// revoked_jtis
export type RevokedJti = typeof revokedJtisTable.$inferSelect;
export type NewRevokedJti = typeof revokedJtisTable.$inferInsert;

// webauthn_credentials
export type WebauthnCredential = typeof webauthnCredentialsTable.$inferSelect;
export type NewWebauthnCredential = typeof webauthnCredentialsTable.$inferInsert;

// credentials
export type Credential = typeof credentialsTable.$inferSelect;
export type NewCredential = typeof credentialsTable.$inferInsert;

// audit_log
export type AuditLog = typeof auditLogTable.$inferSelect;
export type NewAuditLog = typeof auditLogTable.$inferInsert;

/**
 * Discriminated-union literals (handgepflegt — Drizzle leitet TEXT-Spalten
 * als `string` ab, nicht als Literal-Union). Application-Code sollte diese
 * Typen statt raw `string` verwenden.
 */
export type UserRole = 'admin' | 'member';
export type UserStatus = 'active' | 'invited' | 'suspended' | 'deleted';
export type InviteStatus = 'pending' | 'accepted' | 'expired' | 'revoked';
export type CredentialKind = 'oauth_refresh' | 'api_token' | 'password' | 'service_account';
export type ActorType = 'user' | 'system' | 'admin';
export type AuditResult = 'success' | 'denied' | 'error';
export type RevokeReason = 'logout' | 'admin_revoke' | 'replay_detect' | 'rotate';
