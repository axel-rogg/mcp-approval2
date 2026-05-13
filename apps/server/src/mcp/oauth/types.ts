/**
 * OAuth-2.1 + MCP-Spec (Nov 2025) Types.
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Phase 4.
 *
 * RFCs:
 *   - RFC 6749 (OAuth 2.0) — Base.
 *   - RFC 7591 (DCR) — POST /oauth/register payload-shape.
 *   - RFC 7636 (PKCE) — S256-only.
 *   - RFC 7009 (Revocation) — Token revoke endpoint.
 *   - RFC 8414 (Discovery) — /.well-known/oauth-authorization-server.
 *   - RFC 8707 (Resource Indicators) — `resource` param + `aud` claim.
 *   - RFC 9700 (Refresh-Rotation) — Family-revoke on replay.
 */

/** RFC 7591 Client-Metadata (as input to /oauth/register). */
export interface ClientMetadataInput {
  readonly redirect_uris: ReadonlyArray<string>;
  readonly grant_types?: ReadonlyArray<string>;
  readonly response_types?: ReadonlyArray<string>;
  readonly scope?: string;
  readonly token_endpoint_auth_method?: 'client_secret_post' | 'client_secret_basic' | 'none';
  readonly client_name?: string;
  readonly client_uri?: string;
  readonly logo_uri?: string;
  readonly contacts?: ReadonlyArray<string>;
  readonly software_id?: string;
}

/** RFC 7591 Registration-Response (as returned by /oauth/register). */
export interface ClientRegistrationResponse {
  readonly client_id: string;
  readonly client_secret?: string;
  readonly client_id_issued_at: number; // epoch-seconds (RFC 7591)
  readonly client_secret_expires_at?: number; // 0 = no expiry
  readonly registration_access_token?: string;
  readonly registration_client_uri?: string;
  readonly redirect_uris: ReadonlyArray<string>;
  readonly grant_types: ReadonlyArray<string>;
  readonly token_endpoint_auth_method: string;
  readonly client_name?: string;
  readonly client_uri?: string;
  readonly logo_uri?: string;
  readonly contacts?: ReadonlyArray<string>;
  readonly software_id?: string;
  readonly scope?: string;
}

/** RFC 8414 Discovery-Metadata. */
export interface AuthorizationServerMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly registration_endpoint: string;
  readonly revocation_endpoint: string;
  readonly jwks_uri: string;
  readonly scopes_supported: ReadonlyArray<string>;
  readonly response_types_supported: ReadonlyArray<string>;
  readonly grant_types_supported: ReadonlyArray<string>;
  readonly code_challenge_methods_supported: ReadonlyArray<string>;
  readonly token_endpoint_auth_methods_supported: ReadonlyArray<string>;
  readonly revocation_endpoint_auth_methods_supported: ReadonlyArray<string>;
}

/** /oauth/authorize request-Parameter (validated). */
export interface AuthorizeRequest {
  readonly response_type: 'code';
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly scope?: string;
  readonly state?: string;
  readonly code_challenge: string;
  readonly code_challenge_method: 'S256';
  readonly resource?: string; // RFC 8707
}

/** /oauth/token request-Body (after grant_type-Discrimination). */
export type TokenRequest =
  | {
      readonly grant_type: 'authorization_code';
      readonly code: string;
      readonly redirect_uri: string;
      readonly client_id: string;
      readonly client_secret?: string;
      readonly code_verifier: string;
      readonly resource?: string;
    }
  | {
      readonly grant_type: 'refresh_token';
      readonly refresh_token: string;
      readonly client_id: string;
      readonly client_secret?: string;
      readonly scope?: string;
      readonly resource?: string;
    };

/** /oauth/token success-Response. */
export interface TokenResponse {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
  readonly refresh_token?: string;
  readonly scope?: string;
}

/** Access-Token-Claims (JWT-Payload). */
export interface AccessTokenClaims {
  readonly iss: string;
  readonly sub: string; // user_id
  readonly aud: string; // resource (RFC 8707)
  readonly client_id: string;
  readonly scope: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

/** OAuth-Error-Codes (RFC 6749 §5.2 + RFC 7591 + MCP-Spec). */
export type OauthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata'
  | 'unsupported_token_type'
  | 'access_denied'
  | 'server_error';
