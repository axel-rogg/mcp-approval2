/**
 * WebAuthn-Assertion-Verifikation fuer Writemode-Aktivierung.
 *
 * Plan-Ref: docs/plans/active/PLAN-writemode.md (Slice 4).
 *
 * Unterschied zu `approval-verify.ts`:
 *   - Challenge ist NICHT in der DB persistiert — sie wird vom Client aus den
 *     Body-Feldern `{action:'writemode.activate', duration, ts}` deterministisch
 *     gebildet und vom Caller (Route-Handler) selbst kanonikalisiert + b64url-
 *     kodiert weitergereicht.
 *   - Replay-Schutz kommt aus dem TS-Skew-Check der Route (5-Min-Fenster),
 *     plus WebAuthn-Counter-Replay.
 *   - Sonst identische Mechanik: Cross-User-Replay-Check, requireUserVerification,
 *     Counter atomic anheben.
 *
 * Bei Failure → `HttpError.unauthorized(...)`. Caller (Route) baut darum den
 * Audit-Trail (`writemode.activate` mit result='failure').
 */
import {
  verifyAuthenticationResponse,
  type VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/types';
import type { DbAdapter } from '@mcp-approval2/adapters';
import { HttpError } from '../../lib/errors.js';

export interface WritemodeAssertion {
  readonly credentialIdB64: string;
  readonly authenticatorDataB64: string;
  readonly clientDataJsonB64: string;
  readonly signatureB64: string;
  readonly userHandleB64?: string;
}

export interface VerifyWritemodeActivationArgs {
  readonly userId: string;
  readonly expectedChallenge: string;
  readonly expectedOrigin: string;
  readonly expectedRpId: string;
  readonly assertion: WritemodeAssertion;
}

export interface VerifyWritemodeActivationDeps {
  readonly db: DbAdapter;
}

/**
 * Factory: returnt einen verifier-callback mit gebundener DB. Wird in
 * `app-factory.ts` einmalig gebaut und in `writemodeUserRoutes` injected.
 */
export function createWritemodeActivationVerifier(
  deps: VerifyWritemodeActivationDeps,
): (args: VerifyWritemodeActivationArgs) => Promise<void> {
  return (args) => verifyWritemodeActivation(deps, args);
}

export async function verifyWritemodeActivation(
  deps: VerifyWritemodeActivationDeps,
  args: VerifyWritemodeActivationArgs,
): Promise<void> {
  const { db } = deps;
  const credId = args.assertion.credentialIdB64;

  // Credential laden + Cross-User-Check. Lookup ist RLS-frei (unsafe-raw),
  // weil wir den userId-mismatch HIER explizit pruefen.
  const raw = db.unsafe('writemode_webauthn_lookup');
  const rows = await raw.query<{
    userId: string;
    credentialId: string;
    publicKey: Buffer;
    counter: number;
    transports: string | null;
  }>(
    `SELECT user_id AS "userId", credential_id AS "credentialId", public_key AS "publicKey",
            counter, transports
       FROM webauthn_credentials
      WHERE credential_id = $1 AND invalidated_at IS NULL
      LIMIT 1`,
    [credId],
  );
  const cred = rows[0];
  if (!cred) {
    throw HttpError.unauthorized('webauthn_credential_unknown');
  }
  if (cred.userId !== args.userId) {
    throw HttpError.unauthorized('webauthn_credential_owner_mismatch');
  }

  const responseJSON: AuthenticationResponseJSON = {
    id: credId,
    rawId: credId,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: args.assertion.clientDataJsonB64,
      authenticatorData: args.assertion.authenticatorDataB64,
      signature: args.assertion.signatureB64,
      ...(args.assertion.userHandleB64
        ? { userHandle: args.assertion.userHandleB64 }
        : {}),
    },
  };
  const credentialTransports = cred.transports
    ? (JSON.parse(cred.transports) as AuthenticatorTransportFuture[])
    : undefined;
  const credentialBase = {
    id: cred.credentialId,
    publicKey: new Uint8Array(cred.publicKey),
    counter: cred.counter,
  };
  const credentialForVerify =
    credentialTransports !== undefined
      ? { ...credentialBase, transports: credentialTransports }
      : credentialBase;

  let verification: VerifiedAuthenticationResponse;
  try {
    verification = await verifyAuthenticationResponse({
      response: responseJSON,
      expectedChallenge: args.expectedChallenge,
      expectedOrigin: args.expectedOrigin,
      expectedRPID: args.expectedRpId,
      credential: credentialForVerify,
      requireUserVerification: true,
    });
  } catch (err) {
    throw HttpError.unauthorized('webauthn_verification_failed', {
      cause: err instanceof Error ? err.message : 'verify error',
      action: 'writemode.activate',
    });
  }
  if (!verification.verified) {
    throw HttpError.unauthorized('webauthn_verification_failed', {
      action: 'writemode.activate',
    });
  }

  const newCounter = verification.authenticationInfo.newCounter;
  const scoped = await db.scoped(args.userId);
  await scoped.query(
    `UPDATE webauthn_credentials
        SET counter = $1, last_used_at = $2
      WHERE credential_id = $3 AND user_id = $4`,
    [newCounter, Date.now(), cred.credentialId, args.userId],
  );
}
