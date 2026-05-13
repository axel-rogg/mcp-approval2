/**
 * WebAuthn-PRF-Helper.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.4 (Passkey-Enrollment) + §5.3 (PRF-Layer).
 *
 * PRF-Extension liefert eine pro-(credential, salt)-deterministische 32-byte
 * Pseudo-Random-Funktion ueber den Authenticator. Wir nutzen das fuer:
 *   - Approval-Sign-Off (Salt = `approval:<id>`)
 *   - Credential-DEK-XOR (Salt = AAD bzw. credential-Identifier)
 *
 * Wichtig: PRF-Output verlaesst den Browser NIE in der Klartext-Form. Wenn der
 * Server ihn als Sitzungs-DEK braucht, schicken wir ihn b64-encoded ueber
 * TLS + Session-Cookie; auf dem Server lebt er max. 5 min in-memory (PrfSessions).
 */

export interface PrfEvalResult {
  readonly credentialId: Uint8Array;
  readonly assertion: AuthenticatorAssertionResponse;
  readonly clientDataJson: Uint8Array;
  readonly authenticatorData: Uint8Array;
  readonly signature: Uint8Array;
  readonly userHandle: Uint8Array | null;
  readonly prfOutput: Uint8Array;
}

export interface EvalPrfArgs {
  readonly salt: Uint8Array;
  readonly challenge?: Uint8Array;
  readonly allowCredentials?: PublicKeyCredentialDescriptor[];
}

interface PrfExtensionInputs extends AuthenticationExtensionsClientInputs {
  prf?: { eval?: { first: BufferSource; second?: BufferSource } };
}

interface PrfExtensionOutputs {
  prf?: { results?: { first?: ArrayBuffer; second?: ArrayBuffer } };
}

/**
 * Performs WebAuthn-Login mit PRF-Extension.
 *
 * @param args.salt — PRF-eval-Salt (credential-AAD oder approval-challenge)
 * @param args.challenge — optional Server-Challenge (sonst random); fuer
 *   sign-off MUSS der Server-Challenge genutzt werden, damit die Signature
 *   gegen Replay geschuetzt ist
 * @param args.allowCredentials — optional Liste der zugelassenen Credentials
 *
 * @throws Error wenn der Authenticator kein PRF supported oder der User abbricht
 */
export async function evalPrf(args: EvalPrfArgs): Promise<PrfEvalResult> {
  if (typeof navigator === 'undefined' || !('credentials' in navigator)) {
    throw new Error('WebAuthn nicht verfuegbar in diesem Browser.');
  }

  const challenge = args.challenge ?? crypto.getRandomValues(new Uint8Array(32));

  const publicKey: PublicKeyCredentialRequestOptions & { extensions?: PrfExtensionInputs } = {
    challenge: toBuffer(challenge),
    timeout: 60_000,
    userVerification: 'required',
    ...(args.allowCredentials ? { allowCredentials: args.allowCredentials } : {}),
    extensions: {
      prf: { eval: { first: toBuffer(args.salt) } },
    },
  };

  const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!credential) throw new Error('User hat WebAuthn abgebrochen.');

  const extResults = credential.getClientExtensionResults() as PrfExtensionOutputs;
  const prfFirst = extResults.prf?.results?.first;
  if (!prfFirst) {
    throw new Error('PRF wird von diesem Authenticator nicht unterstuetzt.');
  }

  const assertion = credential.response as AuthenticatorAssertionResponse;
  return {
    credentialId: new Uint8Array(credential.rawId),
    assertion,
    clientDataJson: new Uint8Array(assertion.clientDataJSON),
    authenticatorData: new Uint8Array(assertion.authenticatorData),
    signature: new Uint8Array(assertion.signature),
    userHandle: assertion.userHandle ? new Uint8Array(assertion.userHandle) : null,
    prfOutput: new Uint8Array(prfFirst),
  };
}

/**
 * Variante fuer Enrollment: ruft `navigator.credentials.create` mit PRF-Eval.
 * Backend liefert die `creation_options`, wir injecten `extensions.prf` und
 * geben das volle Attestation-Objekt zurueck.
 */
export interface EnrollPrfArgs {
  readonly options: PublicKeyCredentialCreationOptions;
  readonly salt?: Uint8Array;
}

export interface EnrollPrfResult {
  readonly credential: PublicKeyCredential;
  readonly credentialId: Uint8Array;
  readonly attestation: AuthenticatorAttestationResponse;
  readonly prfSupported: boolean;
  readonly prfOutput: Uint8Array | null;
}

interface PrfCreateExtensionInputs extends AuthenticationExtensionsClientInputs {
  prf?: { eval?: { first: BufferSource } };
}

export async function enrollPasskeyWithPrf(args: EnrollPrfArgs): Promise<EnrollPrfResult> {
  if (typeof navigator === 'undefined' || !('credentials' in navigator)) {
    throw new Error('WebAuthn nicht verfuegbar in diesem Browser.');
  }
  const ext: PrfCreateExtensionInputs = {
    ...(args.options.extensions ?? {}),
    prf: args.salt ? { eval: { first: toBuffer(args.salt) } } : {},
  };
  const opts: PublicKeyCredentialCreationOptions = { ...args.options, extensions: ext };
  const cred = (await navigator.credentials.create({ publicKey: opts })) as PublicKeyCredential | null;
  if (!cred) throw new Error('User hat WebAuthn-Enrollment abgebrochen.');
  const extResults = cred.getClientExtensionResults() as PrfExtensionOutputs & {
    prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
  };
  const prfFirst = extResults.prf?.results?.first ?? null;
  const prfSupported = extResults.prf?.enabled === true || prfFirst !== null;
  return {
    credential: cred,
    credentialId: new Uint8Array(cred.rawId),
    attestation: cred.response as AuthenticatorAttestationResponse,
    prfSupported,
    prfOutput: prfFirst ? new Uint8Array(prfFirst) : null,
  };
}

/**
 * Encode `Uint8Array` → base64url (no padding) — same shape the server uses.
 */
export function bytesToB64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] ?? 0);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Encode `Uint8Array` → plain base64 (with padding) — used for prfOutputB64.
 */
export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] ?? 0);
  return btoa(s);
}

export function b64UrlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * TS-strict-friendly: `Uint8Array<ArrayBufferLike>` is not assignable to
 * `BufferSource` in newer DOM-libs — copy into a fresh `ArrayBuffer`.
 */
function toBuffer(u: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
}
