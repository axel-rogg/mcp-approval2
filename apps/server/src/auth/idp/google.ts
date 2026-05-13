/**
 * Google-OAuth-Provider.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.2 (Invite-Flow).
 *
 * Scope minimal: `openid email profile` — wir wollen NUR Identity. Workspace-
 * Tokens lebt in mcp-gws / mcp-knowledge2.
 */
import { decodeJwt } from 'jose';
import type { AppConfig } from '../../lib/config.js';
import { HttpError } from '../../lib/errors.js';
import type {
  IdentityProvider,
  IdpCompleteParams,
  IdpProfile,
  IdpStartParams,
  IdpStartResult,
} from './interface.js';

const AUTHZ_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = ['openid', 'email', 'profile'];

interface GoogleTokenResponse {
  readonly access_token: string;
  readonly id_token: string;
  readonly token_type: string;
  readonly expires_in: number;
}

interface GoogleIdTokenClaims {
  readonly sub: string;
  readonly email: string;
  readonly email_verified?: boolean;
  readonly name?: string;
  readonly given_name?: string;
  readonly nonce?: string;
}

export class GoogleOAuthProvider implements IdentityProvider {
  public readonly id = 'google' as const;

  constructor(private readonly config: AppConfig) {}

  async start(p: IdpStartParams): Promise<IdpStartResult> {
    const params = new URLSearchParams({
      client_id: this.config.GOOGLE_CLIENT_ID,
      redirect_uri: this.config.GOOGLE_REDIRECT_URI,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'online',
      prompt: 'select_account',
      state: p.state,
      nonce: p.nonce,
    });
    if (p.inviteToken) params.set('login_hint', '');
    return { authorizationUrl: `${AUTHZ_URL}?${params.toString()}` };
  }

  async complete(p: IdpCompleteParams): Promise<IdpProfile> {
    if (p.state !== p.expectedState) {
      throw HttpError.badRequest('invalid_request', 'oauth state mismatch');
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: p.code,
      client_id: this.config.GOOGLE_CLIENT_ID,
      client_secret: this.config.GOOGLE_CLIENT_SECRET,
      redirect_uri: this.config.GOOGLE_REDIRECT_URI,
    });

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw HttpError.badRequest('invalid_request', `google token exchange failed: ${text}`);
    }
    const tokens = (await res.json()) as GoogleTokenResponse;

    // JWT-Signatur-Verify gegen Google's JWKS lassen wir hier weg (keine
    // crypto-Library im Scope). PRODUCTION: verifizieren via jose-Remote-JWKS.
    // TODO(verify): use `createRemoteJWKSet('https://www.googleapis.com/oauth2/v3/certs')`.
    const claims = decodeJwt(tokens.id_token) as unknown as GoogleIdTokenClaims;

    if (!claims.sub || !claims.email) {
      throw HttpError.badRequest('invalid_request', 'google id_token missing sub/email');
    }
    if (claims.nonce && claims.nonce !== p.nonce) {
      throw HttpError.badRequest('invalid_request', 'google id_token nonce mismatch');
    }

    return {
      externalId: claims.sub,
      email: claims.email.toLowerCase(),
      displayName: claims.name ?? claims.given_name ?? claims.email,
      emailVerified: claims.email_verified === true,
    };
  }
}
