/**
 * oauth_clients + oauth_authz_codes + oauth_refresh_tokens — MCP-OAuth-2.1.
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Phase 4 (OAuth 2.1 + PKCE Endpoints),
 *           §9 (Sub-MCP-Auth-Strategien).
 *
 * MCP-Spec-Konformitaet (Nov 2025):
 *   - OAuth 2.1 + PKCE-S256 Pflicht (RFC 7636).
 *   - Resource-Indicators (RFC 8707) — Token-`aud`-Claim Pflicht.
 *   - Dynamic Client Registration (RFC 7591) — /oauth/register.
 *   - Authorization-Server-Discovery (RFC 8414) —
 *     /.well-known/oauth-authorization-server.
 *
 * Drei Tabellen:
 *   - oauth_clients: pre-registered + dynamisch registrierte MCP-Clients.
 *   - oauth_authz_codes: kurzlebige Auth-Codes (60s TTL, one-shot).
 *   - oauth_refresh_tokens: Refresh-Token-Familien mit Replay-Detection
 *     (RFC 9700 rotation, eigene Familie pro initialem Issue).
 *
 * Hinweis: Diese Tabellen sind separat von `sessions`/`refresh_tokens`
 * (Login-Sessions des Users). Der `/oauth/*`-Flow ist Client→Server-OAuth
 * fuer MCP, NICHT der Browser-Login-Flow.
 */
import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * oauth_clients-Tabelle.
 *
 * - `client_id`: TEXT-PK (UUID-string bei DCR, sprechende ID bei pre-registered).
 * - `client_secret_hash`: SHA-256 vom Secret. NULL = public client (PKCE-only).
 * - `redirect_uris`: JSONB-Array. Exact-Match-Validation.
 * - `grant_types`: JSONB-Array — i.d.R. ['authorization_code', 'refresh_token'].
 * - `scope`: space-separated default-scope-string. NULL = client requests
 *   im /authorize Call.
 * - `registration_source`: 'dcr' (RFC 7591) | 'cimd' (Client Identifier
 *   Metadata Document) | 'pre-registered' (statisch im Code/Konfig).
 * - `registration_access_token_hash`: bei DCR — SHA-256 vom Token, mit dem
 *   der Client seine eigene Registration updaten/loeschen darf (RFC 7592).
 * - `expires_at`: NULL = unbefristet. Bei DCR kann der AS optional TTL
 *   setzen (z.B. 90 Tage, danach Re-Registration noetig).
 */
export const oauthClientsTable = pgTable(
  'oauth_clients',
  {
    clientId: text('client_id').primaryKey(),
    clientSecretHash: text('client_secret_hash'),
    redirectUris: jsonb('redirect_uris').$type<readonly string[]>().notNull(),
    grantTypes: jsonb('grant_types')
      .$type<readonly string[]>()
      .notNull()
      .default(['authorization_code', 'refresh_token']),
    scope: text('scope'),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method').default('client_secret_post'),
    clientName: text('client_name'),
    clientUri: text('client_uri'),
    logoUri: text('logo_uri'),
    contacts: jsonb('contacts').$type<readonly string[]>(),
    softwareId: text('software_id'),
    registrationAccessTokenHash: text('registration_access_token_hash'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }),
    registrationSource: text('registration_source').notNull(),
  },
  (t) => ({
    sourceIdx: index('idx_oauth_clients_source').on(t.registrationSource),
    expiresIdx: index('idx_oauth_clients_expires').on(t.expiresAt),
  })
);

/**
 * oauth_authz_codes-Tabelle.
 *
 * Auth-Code-Flow mit PKCE:
 *   1. Client redirected User auf /oauth/authorize?...&code_challenge=...
 *   2. User approved → Server insertet Row, redirected mit ?code=<raw>
 *   3. Client POSTed /oauth/token mit code + code_verifier
 *   4. Server matcht hash(code) → row → validiert PKCE + setzt used_at
 *
 * - `code_hash`: SHA-256(raw_code) — raw nie persistiert.
 * - `resource`: RFC 8707 audience. Token-aud-Claim wird daraus gesetzt.
 * - `code_challenge_method`: nur 'S256' supported.
 * - `expires_at`: 60s TTL (PKCE-Spec).
 * - `used_at`: One-Shot — Second-Use → 401 + Audit-Event.
 */
export const oauthAuthzCodesTable = pgTable(
  'oauth_authz_codes',
  {
    codeHash: text('code_hash').primaryKey(),
    clientId: text('client_id').notNull(),
    userId: uuid('user_id').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    scope: text('scope'),
    resource: text('resource'),
    codeChallenge: text('code_challenge').notNull(),
    codeChallengeMethod: text('code_challenge_method').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    usedAt: bigint('used_at', { mode: 'number' }),
  },
  (t) => ({
    expiresIdx: index('idx_oauth_codes_expires').on(t.expiresAt),
    clientIdx: index('idx_oauth_codes_client').on(t.clientId),
  })
);

/**
 * oauth_refresh_tokens-Tabelle.
 *
 * Refresh-Token-Familien (RFC 9700 rotation):
 *   - Initial-Issue: family_id = neue UUID, rotated_at = NULL.
 *   - Bei Rotate: alte Row rotated_at gesetzt, neue Row mit gleicher family_id.
 *   - Replay-Detect: rotated-Row erneut benutzt → ALLE Rows der family revoken.
 *
 * - `token_hash`: SHA-256(raw_refresh) — raw nie persistiert.
 * - `family_id`: UUID — gemeinsam fuer alle Rotations einer Initial-Issue.
 * - `rotated_at`: gesetzt wenn der Token bereits gegen einen neuen
 *   getauscht wurde (legitime Rotation). Wenn revoked_at NULL + rotated_at
 *   NOT NULL: zweiter Use → Replay → family revoken.
 * - `revoked_at`/`revoke_reason`: durch explicit revoke ODER replay-detect.
 */
export const oauthRefreshTokensTable = pgTable(
  'oauth_refresh_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    clientId: text('client_id').notNull(),
    userId: uuid('user_id').notNull(),
    scope: text('scope'),
    resource: text('resource'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    rotatedAt: bigint('rotated_at', { mode: 'number' }),
    familyId: uuid('family_id').notNull(),
    revokedAt: bigint('revoked_at', { mode: 'number' }),
    revokeReason: text('revoke_reason'),
  },
  (t) => ({
    familyIdx: index('idx_oauth_refresh_family').on(t.familyId),
    clientIdx: index('idx_oauth_refresh_client').on(t.clientId),
    userIdx: index('idx_oauth_refresh_user').on(t.userId),
    expiresIdx: index('idx_oauth_refresh_expires').on(t.expiresAt),
  })
);
