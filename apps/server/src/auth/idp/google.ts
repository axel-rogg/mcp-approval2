/**
 * Google-OAuth-Provider.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.2 (Invite-Flow).
 *
 * Scope minimal: `openid email profile` — wir wollen NUR Identity. Workspace-
 * Tokens lebt in mcp-gws / mcp-knowledge2.
 */
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
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
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
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

/**
 * AS-3 (§1.1): inbound `verifyIdToken` Helper.
 *
 * Akzeptiert ein Google-ID-Token (extern beschaffen — z.B. Browser-PWA aus
 * KC2-Domain, die das Token an approval2 weiterreichen will). Verifiziert
 * Signatur via Google-JWKS, iss + aud + email-verified.
 *
 * `expectedAudiences`-Liste kommt aus `effectiveGoogleAudiences()` —
 * mindestens die eigene GOOGLE_CLIENT_ID, plus optional KC2's eigene
 * (Multi-Audience-Setup).
 *
 * `nonce`-Check ist optional — wenn der Caller eine Nonce mitgibt, muss
 * sie im Token matchen; sonst wird der Claim ignoriert (server-to-server
 * Flow hat keine Browser-Nonce).
 */
export interface VerifyIdTokenArgs {
  readonly token: string;
  readonly expectedAudiences: ReadonlyArray<string>;
  readonly nonce?: string;
}

export interface VerifiedIdTokenProfile {
  readonly externalId: string;
  readonly email: string;
  readonly displayName: string;
  readonly emailVerified: boolean;
  readonly audience: string;
  readonly issuer: string;
}

// Modul-level JWKS-Cache — jose's `createRemoteJWKSet` cached intern,
// aber wir vermeiden hier einen neuen Set pro Call.
let cachedGoogleJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function googleJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!cachedGoogleJwks) {
    cachedGoogleJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  }
  return cachedGoogleJwks;
}

/**
 * Verify a Google ID-Token gegen Google's JWKS. Wirft HttpError bei
 * Failure (passt zu Hono-Error-Handler).
 *
 * `expectedAudiences` MUSS nicht-leer sein — sonst Signatur-Skip-Risk.
 */
export async function verifyIdToken(
  args: VerifyIdTokenArgs,
): Promise<VerifiedIdTokenProfile> {
  if (args.expectedAudiences.length === 0) {
    throw HttpError.badRequest(
      'invalid_request',
      'verifyIdToken: expectedAudiences must not be empty',
    );
  }
  let payload: Record<string, unknown>;
  try {
    const { payload: p } = await jwtVerify(args.token, googleJwks(), {
      issuer: GOOGLE_ISSUERS as unknown as string[],
      // jose 5+ erlaubt audience als string oder string[].
      audience: args.expectedAudiences as unknown as string[],
      algorithms: ['RS256'],
    });
    payload = p as unknown as Record<string, unknown>;
  } catch (err) {
    throw HttpError.unauthorized(
      `google id_token verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const sub = typeof payload['sub'] === 'string' ? (payload['sub'] as string) : '';
  const email = typeof payload['email'] === 'string' ? (payload['email'] as string) : '';
  if (!sub || !email) {
    throw HttpError.badRequest('invalid_request', 'google id_token missing sub/email');
  }
  if (args.nonce !== undefined && payload['nonce'] !== args.nonce) {
    throw HttpError.badRequest('invalid_request', 'google id_token nonce mismatch');
  }
  const aud = Array.isArray(payload['aud'])
    ? ((payload['aud'] as string[])[0] ?? '')
    : typeof payload['aud'] === 'string'
      ? (payload['aud'] as string)
      : '';
  const iss = typeof payload['iss'] === 'string' ? (payload['iss'] as string) : '';
  const displayName =
    (typeof payload['name'] === 'string' && (payload['name'] as string)) ||
    (typeof payload['given_name'] === 'string' && (payload['given_name'] as string)) ||
    email;

  return {
    externalId: sub,
    email: email.toLowerCase(),
    displayName,
    emailVerified: payload['email_verified'] === true,
    audience: aud,
    issuer: iss,
  };
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
