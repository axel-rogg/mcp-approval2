/**
 * WebAuthn Passkey-Enrollment mit PRF-Extension.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.4 (Passkey-Enrollment).
 *
 * PRF: wir fordern bei Enrollment `extensions.prf` an. Der Authenticator
 * meldet zurueck, ob er PRF supported. Das speichern wir als `prf_supported`
 * in `webauthn_credentials`. Echte PRF-Eval-Outputs werden NICHT bei der
 * Enrollment uebertragen — nur bei Login (siehe authentication.ts).
 *
 * Multi-Origin (Coop-Bypass via Hetzner-FQDN, PLAN-architecture-v1.md §3.4):
 * `beginRegistration`/`finishRegistration` lesen RP-ID + RP-Origin aktuell
 * aus `config.RP_ID`/`config.RP_ORIGIN`. Fuer Multi-Origin-Support sollte
 * der Caller (HTTP-Handler) `resolveOrigin(request, config)` +
 * `resolveRpId(origin)` aus `lib/config.ts` aufrufen und das Ergebnis als
 * Override-Felder reinreichen (siehe TODO unten). Bis dahin: ein
 * RP_ID/RP_ORIGIN pro Deployment, Coop-Browser nutzt die FQDN-Variante via
 * separater RP-ID + separatem Passkey-Enrollment.
 */
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type GenerateRegistrationOptionsOpts,
  type VerifiedRegistrationResponse,
} from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/types';
import type { DbAdapter } from '@mcp-approval2/adapters';
import type { AppConfig } from '../../lib/config.js';
import { HttpError } from '../../lib/errors.js';

export interface EnrollBeginInput {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  /** Salt fuer PRF-eval (32 random bytes) — pro Credential einzigartig. */
  readonly prfSalt: Uint8Array;
  /**
   * Optional per-request RP-ID Override (Multi-Origin-Setup). Wenn weg →
   * `config.RP_ID` als Default. Wird im Caller aus
   * `resolveRpId(requestOrigin, config)` abgeleitet.
   */
  readonly rpId?: string;
}

export interface EnrollBeginResult {
  readonly options: Awaited<ReturnType<typeof generateRegistrationOptions>>;
  /** Challenge muss aus `options.challenge` extrahiert werden — Caller speichert sie pro Session. */
  readonly challenge: string;
}

export async function beginRegistration(
  config: AppConfig,
  input: EnrollBeginInput,
): Promise<EnrollBeginResult> {
  const opts: GenerateRegistrationOptionsOpts = {
    rpName: config.RP_NAME,
    rpID: input.rpId ?? config.RP_ID,
    userID: new TextEncoder().encode(input.userId),
    userName: input.email,
    userDisplayName: input.displayName,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      // SEC-009: Biometrie / PIN-Pflicht ab Enrollment-Zeit. Authenticators
      // ohne UV (z.B. Sicherheits-Keys ohne Pin-Setup) werden NICHT enrolled.
      userVerification: 'required',
    },
    extensions: {
      // PRF-Extension nicht im DOM-Type, aber im Spec.
      ...({ prf: { eval: { first: input.prfSalt } } } as Record<string, unknown>),
    },
    supportedAlgorithmIDs: [-7, -257], // ES256 + RS256
  };
  const options = await generateRegistrationOptions(opts);
  return { options, challenge: options.challenge };
}

export interface EnrollFinishInput {
  readonly userId: string;
  readonly response: RegistrationResponseJSON;
  readonly expectedChallenge: string;
  /** Optional per-request Overrides aus dem Begin-Schritt. */
  readonly rpId?: string;
  readonly expectedOrigin?: string;
}

export interface EnrollFinishResult {
  readonly credentialId: string;
  readonly publicKey: Uint8Array;
  readonly counter: number;
  readonly prfSupported: boolean;
  readonly transports: ReadonlyArray<string>;
}

export async function finishRegistration(
  config: AppConfig,
  db: DbAdapter,
  input: EnrollFinishInput,
): Promise<EnrollFinishResult> {
  // Multi-Origin: bevorzugt die per-Request berechneten rpId + expectedOrigin
  // (Caller liefert diese aus Begin-Step ueber den Challenge-Store). Fallback
  // auf config-Liste fuer Tests / Boot-Phase.
  const expectedOrigin = input.expectedOrigin
    ? [input.expectedOrigin]
    : Array.from(
        new Set([config.RP_ORIGIN, ...config.ALLOWED_ORIGINS].filter(Boolean)),
      );
  const expectedRPID = input.rpId ?? config.RP_ID;
  const verification: VerifiedRegistrationResponse = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin,
    expectedRPID,
    // SEC-009: zur Enrollment-Time pruefen wir, dass der Authenticator UV
    // tatsaechlich performed hat (Flag im authData). Ohne UV → 400.
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw HttpError.badRequest('webauthn_verification_failed', 'registration verification failed');
  }
  const credential = verification.registrationInfo.credential;
  const credentialId = credential.id;
  const publicKey = credential.publicKey;
  const counter = credential.counter;

  // PRF-Support-Detection: wenn die Authenticator-Antwort einen `prf`-Extension-Result
  // mit `enabled: true` hat → supported.
  const ext = input.response.clientExtensionResults as unknown as { prf?: { enabled?: boolean } } | undefined;
  const prfSupported = ext?.prf?.enabled === true;

  const scoped = await db.scoped(input.userId);
  await scoped.query(
    `INSERT INTO webauthn_credentials
       (user_id, credential_id, public_key, counter, prf_supported, transports, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.userId,
      credentialId,
      Buffer.from(publicKey),
      counter,
      prfSupported,
      JSON.stringify(input.response.response.transports ?? []),
      Date.now(),
    ],
  );

  return {
    credentialId,
    publicKey,
    counter,
    prfSupported,
    transports: input.response.response.transports ?? [],
  };
}
