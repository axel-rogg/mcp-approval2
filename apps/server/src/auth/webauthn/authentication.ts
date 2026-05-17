/**
 * WebAuthn Passkey-Login mit PRF-Eval.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.4 (Passkey), §5 (Crypto).
 *
 * PRF-Eval-Salt: laden wir pro Credential aus `webauthn_credentials.prf_salt`
 * (1 stabiles Salt pro Passkey). PRF-Output wird vom Browser zurueckgeliefert
 * und kann clientseitig zum Entschluesseln des User-DEK genutzt werden
 * (Phase 2 — hier vorbereitet, noch nicht aktiv).
 */
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type GenerateAuthenticationOptionsOpts,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/types';
import type { DbAdapter } from '@mcp-approval2/adapters';
import type { AppConfig } from '../../lib/config.js';
import { HttpError } from '../../lib/errors.js';

export interface LoginBeginInput {
  /** Optional: wenn bekannt (z.B. nach Email-Eingabe) — engt Credentials ein. */
  readonly userId?: string;
}

export interface LoginBeginResult {
  readonly options: Awaited<ReturnType<typeof generateAuthenticationOptions>>;
  readonly challenge: string;
}

export async function beginAuthentication(
  config: AppConfig,
  db: DbAdapter,
  input: LoginBeginInput,
): Promise<LoginBeginResult> {
  let allowCredentials:
    | Array<{ id: string; transports?: AuthenticatorTransportFuture[] }>
    | undefined;
  let prfSalts: Uint8Array[] | undefined;
  if (input.userId) {
    const scoped = await db.scoped(input.userId);
    const rows = await scoped.query<{
      credentialId: string;
      transports: string;
      prfSalt: Buffer | null;
    }>(
      `SELECT credential_id AS "credentialId", transports, prf_salt AS "prfSalt"
         FROM webauthn_credentials
        WHERE user_id = $1 AND invalidated_at IS NULL`,
      [input.userId],
    );
    allowCredentials = rows.map((r) => {
      const transports = r.transports ? (JSON.parse(r.transports) as AuthenticatorTransportFuture[]) : undefined;
      return transports !== undefined ? { id: r.credentialId, transports } : { id: r.credentialId };
    });
    prfSalts = rows.map((r) => (r.prfSalt ? new Uint8Array(r.prfSalt) : new Uint8Array(32)));
  }

  const prfEval =
    prfSalts && prfSalts.length > 0 && prfSalts[0]
      ? { prf: { eval: { first: prfSalts[0] } } }
      : undefined;

  const baseOpts: GenerateAuthenticationOptionsOpts = {
    rpID: config.RP_ID,
    // SEC-009: PIN/Biometrie pflicht bei Login. Authenticators die UV nicht
    // koennen werden gar nicht erst angeboten (Hardware-Keys ohne PIN-Setup).
    userVerification: 'required',
    ...(allowCredentials ? { allowCredentials } : {}),
  };
  const opts: GenerateAuthenticationOptionsOpts = prfEval
    ? { ...baseOpts, extensions: prfEval as unknown as NonNullable<GenerateAuthenticationOptionsOpts['extensions']> }
    : baseOpts;
  const options = await generateAuthenticationOptions(opts);
  return { options, challenge: options.challenge };
}

export interface LoginFinishInput {
  readonly response: AuthenticationResponseJSON;
  readonly expectedChallenge: string;
}

export interface LoginFinishResult {
  readonly userId: string;
  readonly credentialId: string;
  readonly newCounter: number;
  /** PRF-Output (base64url) wenn Authenticator es geliefert hat. Phase 2: nutzen fuer DEK-decrypt. */
  readonly prfFirst?: string;
}

export async function finishAuthentication(
  config: AppConfig,
  db: DbAdapter,
  input: LoginFinishInput,
): Promise<LoginFinishResult> {
  // Look up credential by id (raw, kein User-Scope bekannt vorher).
  const raw = db.unsafe('webauthn_credential_lookup');
  const credId = input.response.id;
  const rows = await raw.query<{
    userId: string;
    credentialId: string;
    publicKey: Buffer;
    counter: number;
    transports: string;
  }>(
    `SELECT user_id AS "userId", credential_id AS "credentialId", public_key AS "publicKey",
            counter, transports
       FROM webauthn_credentials
      WHERE credential_id = $1 AND invalidated_at IS NULL LIMIT 1`,
    [credId],
  );
  const cred = rows[0];
  if (!cred) throw HttpError.unauthorized('webauthn_credential_unknown');

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

  // Multi-Origin: PWA kann auf einem anderen Sub-Domain leben als API-Server
  // (z.B. app2.ai-toolhub.org vs mcp2.ai-toolhub.org). simplewebauthn akzeptiert
  // ein Array — alle erlaubten Origins durchreichen.
  const allowedOrigins = Array.from(
    new Set([config.RP_ORIGIN, ...config.ALLOWED_ORIGINS].filter(Boolean)),
  );
  const verification = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: allowedOrigins,
    expectedRPID: config.RP_ID,
    credential: credentialForVerify,
    // SEC-009: UV-Bit muss in der Assertion gesetzt sein.
    requireUserVerification: true,
  });
  if (!verification.verified) {
    throw HttpError.unauthorized('webauthn_verification_failed');
  }

  const info = verification.authenticationInfo;
  const newCounter = info.newCounter;

  // Counter update (replay protection per spec)
  const scoped = await db.scoped(cred.userId);
  await scoped.query(
    `UPDATE webauthn_credentials SET counter = $1, last_used_at = $2 WHERE credential_id = $3`,
    [newCounter, Date.now(), cred.credentialId],
  );

  const ext = input.response.clientExtensionResults as unknown as
    | { prf?: { results?: { first?: string } } }
    | undefined;
  const result: LoginFinishResult = {
    userId: cred.userId,
    credentialId: cred.credentialId,
    newCounter,
    ...(ext?.prf?.results?.first ? { prfFirst: ext.prf.results.first } : {}),
  };
  return result;
}
