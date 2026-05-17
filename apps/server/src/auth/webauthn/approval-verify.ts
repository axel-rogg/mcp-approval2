/**
 * WebAuthn-Assertion-Verifikation fuer den Approval-Sign-Off.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.4 (Passkey), §11 Phase 4 (Approval).
 *
 * SEC-001: Vor dieser Routine wurde die Approval `approval_signature` blind
 * persistiert ohne Verifikation — ein Angreifer der ein gueltiges Session-JWT
 * hatte konnte mit beliebigen Bytes "approven". Diese Routine prueft die
 * WebAuthn-Assertion gegen die in `pending_approvals.approval_challenge`
 * gespeicherte Server-Challenge. SEC-009 koppelt das auf `userVerification:
 * 'required'` (Biometrie/PIN-Pflicht).
 *
 * Ablauf:
 *   1. Credential aus `webauthn_credentials` laden (Lookup per credentialIdB64).
 *   2. Cross-User-Replay-Schutz: cred.user_id MUSS == args.userId.
 *      Auch wenn der API-Caller via Session als userId-X authentifiziert ist,
 *      darf er kein Credential eines anderen Users nutzen.
 *   3. `verifyAuthenticationResponse({ requireUserVerification: true, ... })`.
 *   4. Counter atomic anheben — replay-protection per WebAuthn-Spec.
 *
 * Bei Failure → `HttpError.unauthorized('webauthn_verification_failed')`. Der
 * Caller (Route-Handler) sollte VOR `approvals.approve()` verifizieren, damit
 * die Approval bei Failure NICHT auf 'approved' flippt.
 */
import {
  verifyAuthenticationResponse,
  type VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture } from '@simplewebauthn/types';
import type { DbAdapter } from '@mcp-approval2/adapters';
import { HttpError } from '../../lib/errors.js';

export interface ApprovalAssertion {
  readonly credentialIdB64: string;
  readonly authenticatorDataB64: string;
  readonly clientDataJsonB64: string;
  readonly signatureB64: string;
  /** userHandle ist bei WebAuthn-Discoverable-Credentials gesetzt. Optional. */
  readonly userHandleB64?: string;
}

export interface VerifyApprovalAssertionArgs {
  readonly userId: string;
  readonly approvalId: string;
  readonly expectedChallenge: string;
  readonly expectedOrigin: string;
  readonly expectedRpId: string;
  readonly assertion: ApprovalAssertion;
}

export interface VerifyApprovalAssertionDeps {
  readonly db: DbAdapter;
}

/**
 * Factory: returnt einen verifier-callback mit gebundener DB. Wird in
 * `app-factory.ts` einmalig gebaut und in `approvalsRoutes` injected.
 */
export function createApprovalAssertionVerifier(
  deps: VerifyApprovalAssertionDeps,
): (args: VerifyApprovalAssertionArgs) => Promise<void> {
  return (args) => verifyApprovalAssertion(deps, args);
}

export async function verifyApprovalAssertion(
  deps: VerifyApprovalAssertionDeps,
  args: VerifyApprovalAssertionArgs,
): Promise<void> {
  const { db } = deps;
  const credId = args.assertion.credentialIdB64;

  // Step 1+2: Credential laden + Cross-User-Check.
  // Lookup per credential_id ist RLS-frei (unsafe-raw), weil wir den userId-
  // mismatch HIER explizit pruefen.
  const raw = db.unsafe('approval_webauthn_lookup');
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
    // Cross-User-Credential-Replay → behandeln wir wie failed verification.
    // Logging via emitAudit erfolgt im Caller (route-layer).
    throw HttpError.unauthorized('webauthn_credential_owner_mismatch');
  }

  // Step 3: Assertion verifizieren. SimpleWebAuthn akzeptiert die JSON-Shape
  // ueber `response`. clientDataJSON / authenticatorData / signature sind in
  // der JSON `AuthenticationResponseJSON.response.*` einzubetten. Hier bauen
  // wir die JSON aus den b64-Feldern.
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
    // SimpleWebAuthn wirft fuer challenge/origin/rpId mismatch + UV-fail.
    throw HttpError.unauthorized('webauthn_verification_failed', {
      cause: err instanceof Error ? err.message : 'verify error',
      approvalId: args.approvalId,
    });
  }
  if (!verification.verified) {
    throw HttpError.unauthorized('webauthn_verification_failed', {
      approvalId: args.approvalId,
    });
  }

  // Step 4: Counter anheben. WebAuthn-Spec: wenn newCounter <= storedCounter
  // ist das ein Cloned-Authenticator-Indiz; SimpleWebAuthn lehnt das schon im
  // verify-Schritt ab (verified=false). Hier nur Persistieren.
  const newCounter = verification.authenticationInfo.newCounter;
  const scoped = await db.scoped(args.userId);
  await scoped.query(
    `UPDATE webauthn_credentials
        SET counter = $1, last_used_at = $2
      WHERE credential_id = $3 AND user_id = $4`,
    [newCounter, Date.now(), cred.credentialId, args.userId],
  );
}
