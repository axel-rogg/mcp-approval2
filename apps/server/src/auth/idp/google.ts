/**
 * Google-OAuth-Provider.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.2 (Invite-Flow).
 *
 * Scope minimal: `openid email profile` — wir wollen NUR Identity. Workspace-
 * Tokens lebt in mcp-gws / mcp-knowledge2.
 *
 * SEC-002: id_token-Signatur wird via Google's JWKS verifiziert (jwtVerify
 * mit RS256). Der Fallback auf decodeJwt war fail-open — ein MitM-Proxy
 * konnte ein gefaelschtes id_token einschleusen ohne dass approval2 es
 * merkt. Nonce-Pflicht ist jetzt unconditional.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';
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
      redirect_uri: p.redirectUri ?? this.config.GOOGLE_REDIRECT_URI,
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
      // MUSS identisch sein zum redirect_uri aus start(), sonst
      // `redirect_uri_mismatch` von Google.
      redirect_uri: p.redirectUri ?? this.config.GOOGLE_REDIRECT_URI,
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

    // SEC-002: id_token MUSS gegen Google's JWKS verifiziert werden — vorher
    // war hier nur ein decodeJwt() ohne Signature-Check (fail-open). Eine
    // GOOGLE_CLIENT_ID-Liste als expectedAudiences enthaelt die eigene
    // Client-ID plus optional GOOGLE_ALLOWED_AUDIENCES (Multi-Audience-
    // Setup fuer KC2-cross-IdP). Nonce ist jetzt unconditional Pflicht
    // (vorher: `if (claims.nonce && ...)` — claim absent → kein check).
    let verified: VerifiedIdTokenProfile;
    try {
      verified = await verifyIdToken({
        token: tokens.id_token,
        expectedAudiences: effectiveGoogleAudiences(this.config),
        nonce: p.nonce,
      });
    } catch (err) {
      // Re-throw als invalid_request damit Google-callback-Logging
      // klar zeigt, dass das Token vom Google-Token-Endpoint kam aber
      // nicht durch JWKS-Verify ging.
      throw HttpError.badRequest(
        'invalid_request',
        `google id_token verification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {
      externalId: verified.externalId,
      email: verified.email,
      displayName: verified.displayName,
      emailVerified: verified.emailVerified,
    };
  }
}

/**
 * Sammelt die Liste der akzeptierten Google-Audiences:
 *   - Unsere eigene GOOGLE_CLIENT_ID (Pflicht)
 *   - Zusaetzliche GOOGLE_ALLOWED_AUDIENCES (optional — Multi-Audience-Setup)
 *
 * Wird auch fuer inbound `verifyIdToken` aus mcp/oauth/authorize.ts (Google-
 * IdP-Redirect-Path) wiederverwendet — exportiert um Duplikation zu
 * vermeiden.
 */
export function effectiveGoogleAudiences(
  config: Pick<AppConfig, 'GOOGLE_CLIENT_ID' | 'GOOGLE_ALLOWED_AUDIENCES'>,
): string[] {
  const out = new Set<string>([config.GOOGLE_CLIENT_ID]);
  for (const a of config.GOOGLE_ALLOWED_AUDIENCES) {
    if (a) out.add(a);
  }
  return Array.from(out);
}
