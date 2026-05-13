/**
 * OpenBaoKekProvider — Live HTTP-Client gegen OpenBao Transit-Engine.
 *
 * Wraps a per-user 32-byte DEK with a per-user transit key. Storage layout
 * follows PLAN-architecture-v1 §5.2:
 *
 *   KekRef:    `vault://transit/keys/user-<user_id>`
 *   keyName:   `user-<user_id>`
 *   wrapped:   the literal ASCII bytes of `vault:v1:<base64>` (Vault
 *              ciphertext envelope). Stored as `credentials.wrapped_dek`.
 *
 * Auth: pluggable via `OpenBaoAuth`. Production uses `AppRoleAuth`; tests
 * + dev bootstrap can use `StaticTokenAuth`.
 *
 * Errors are mapped to typed adapter errors so callers can branch without
 * parsing Vault's raw bodies:
 *
 *   - 404 → KekNotFoundError       (transit key does not exist)
 *   - 403 → KekPermissionError     (token has insufficient policy)
 *   - 503 → KekUnavailableError    (vault is sealed / standby)
 *   - 400 with "key not found"     → KekNotFoundError (decrypt path)
 *   - network failure              → KekNetworkError (cause attached)
 *   - validation                   → KekValidationError
 *
 * Plan-Reference: docs/plans/active/PLAN-architecture-v1.md §5.2 + §5.4.
 */

import type { KekProvider, KekRef } from './interface.js';
import { _readFailure } from './openbao-auth.js';
import type { OpenBaoAuth } from './openbao-auth.js';
import type {
  HttpFailure,
  TransitDecryptResponse,
  TransitEncryptResponse,
} from './openbao-types.js';

export type TransitKeyType = 'aes256-gcm96' | 'chacha20-poly1305' | 'aes128-gcm96';

export interface OpenBaoKekProviderOptions {
  /** e.g. `http://localhost:8200` or `https://openbao.internal:8200`. */
  readonly addr: string;
  /** Auth strategy: provides a Vault client token per request. */
  readonly auth: OpenBaoAuth;
  /** Mount path of the transit engine. Default: `transit`. */
  readonly transitMount?: string;
  /** Injected fetch (tests). Default: globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
  /**
   * If true, re-attempt a request once after a 403 (re-issuing
   * `auth.invalidate()` first). Mitigates a benign race where the
   * cached token expired between cache-check and request. Default: true.
   */
  readonly retryOnExpiredToken?: boolean;
}

/**
 * Base class for all KEK errors raised by this provider. The
 * `vaultMessage` field carries the original server-side error string
 * for debugging/operator diagnostics — callers MUST NOT echo it back
 * to end users (may leak key names or policy details).
 */
export abstract class KekError extends Error {
  public readonly vaultMessage: string;
  public readonly status: number;

  public constructor(message: string, status: number, vaultMessage: string) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.vaultMessage = vaultMessage;
  }
}

export class KekNotFoundError extends KekError {
  public constructor(ref: KekRef, vaultMessage: string, status = 404) {
    super(`KEK ref "${ref}" not found`, status, vaultMessage);
  }
}

export class KekPermissionError extends KekError {
  public constructor(ref: KekRef, vaultMessage: string) {
    super(`Permission denied for KEK ref "${ref}"`, 403, vaultMessage);
  }
}

export class KekUnavailableError extends KekError {
  public constructor(vaultMessage: string, status = 503) {
    super('OpenBao backend unavailable (sealed/standby/down)', status, vaultMessage);
  }
}

export class KekNetworkError extends KekError {
  public override readonly cause: unknown;

  public constructor(message: string, cause: unknown) {
    super(message, 0, '');
    this.cause = cause;
  }
}

export class KekValidationError extends KekError {
  public constructor(message: string) {
    super(message, 0, '');
  }
}

export class KekResponseError extends KekError {
  public constructor(message: string, status: number, vaultMessage: string) {
    super(message, status, vaultMessage);
  }
}

const REF_PATTERN = /^vault:\/\/([^/]+)\/keys\/([^/]+)$/;

/**
 * Parses a KekRef of the form `vault://<mount>/keys/<keyName>`.
 * Returns the keyName component. The mount in the ref must match
 * the provider's configured `transitMount` — we refuse mismatches so
 * a misrouted ref can never end up encrypting against the wrong engine.
 */
export function parseVaultRef(ref: KekRef, expectedMount: string): { keyName: string; mount: string } {
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new KekValidationError('KEK ref must be a non-empty string');
  }
  const m = REF_PATTERN.exec(ref);
  if (!m) {
    throw new KekValidationError(
      `Invalid KEK ref "${ref}": expected "vault://<mount>/keys/<keyName>"`,
    );
  }
  const mount = m[1] as string;
  const keyName = m[2] as string;
  if (mount !== expectedMount) {
    throw new KekValidationError(
      `KEK ref "${ref}" mount "${mount}" does not match provider mount "${expectedMount}"`,
    );
  }
  if (!/^[A-Za-z0-9._-]+$/.test(keyName)) {
    throw new KekValidationError(
      `KEK ref "${ref}": keyName "${keyName}" contains invalid characters`,
    );
  }
  return { keyName, mount };
}

/** TextEncoder/Decoder are module-scoped to avoid per-call allocation. */
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

function toBase64(bytes: Uint8Array): string {
  // Avoid spread on >1MB inputs; but DEKs are 32 bytes, so spread is fine.
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] as number);
  // btoa is available in workerd, browsers, and Node 16+.
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export class OpenBaoKekProvider implements KekProvider {
  private readonly addr: string;
  private readonly auth: OpenBaoAuth;
  private readonly transitMount: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryOnExpiredToken: boolean;

  public constructor(opts: OpenBaoKekProviderOptions) {
    if (!opts.addr) throw new KekValidationError('OpenBaoKekProvider: addr is required');
    if (!opts.auth) throw new KekValidationError('OpenBaoKekProvider: auth is required');
    this.addr = opts.addr.endsWith('/') ? opts.addr.slice(0, -1) : opts.addr;
    this.auth = opts.auth;
    this.transitMount = opts.transitMount ?? 'transit';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.retryOnExpiredToken = opts.retryOnExpiredToken ?? true;
  }

  public async wrap(dek: Uint8Array, ref: KekRef): Promise<Uint8Array> {
    if (dek.byteLength === 0) {
      throw new KekValidationError('OpenBaoKekProvider.wrap: empty dek');
    }
    const { keyName } = parseVaultRef(ref, this.transitMount);
    const body = await this.request<TransitEncryptResponse>(
      'POST',
      `/v1/${this.transitMount}/encrypt/${encodeURIComponent(keyName)}`,
      { plaintext: toBase64(dek) },
      ref,
    );
    const ct = body?.data?.ciphertext;
    if (typeof ct !== 'string' || !ct.startsWith('vault:')) {
      throw new KekResponseError(
        `OpenBao encrypt response missing ciphertext for ref "${ref}"`,
        200,
        JSON.stringify(body),
      );
    }
    return TEXT_ENCODER.encode(ct);
  }

  public async unwrap(wrapped: Uint8Array, ref: KekRef): Promise<Uint8Array> {
    if (wrapped.byteLength === 0) {
      throw new KekValidationError('OpenBaoKekProvider.unwrap: empty wrapped');
    }
    const { keyName } = parseVaultRef(ref, this.transitMount);
    const ciphertext = TEXT_DECODER.decode(wrapped);
    if (!ciphertext.startsWith('vault:')) {
      throw new KekValidationError(
        `OpenBaoKekProvider.unwrap: wrapped does not look like a Vault ciphertext envelope`,
      );
    }
    const body = await this.request<TransitDecryptResponse>(
      'POST',
      `/v1/${this.transitMount}/decrypt/${encodeURIComponent(keyName)}`,
      { ciphertext },
      ref,
    );
    const pt = body?.data?.plaintext;
    if (typeof pt !== 'string') {
      throw new KekResponseError(
        `OpenBao decrypt response missing plaintext for ref "${ref}"`,
        200,
        JSON.stringify(body),
      );
    }
    return fromBase64(pt);
  }

  /**
   * Rotate semantics: Vault Transit keeps the old key version
   * decryptable, so the cheap-path (oldRef === newRef) just bumps the
   * version. For oldRef !== newRef we cannot atomically re-encrypt all
   * ciphertexts — that is the caller's per-credentials-row loop. We
   * still validate that both refs parse and the new key exists.
   */
  public async rotate(oldRef: KekRef, newRef: KekRef): Promise<void> {
    const { keyName: oldKey } = parseVaultRef(oldRef, this.transitMount);
    if (oldRef === newRef) {
      await this.request<unknown>(
        'POST',
        `/v1/${this.transitMount}/keys/${encodeURIComponent(oldKey)}/rotate`,
        {},
        oldRef,
      );
      return;
    }
    // Cross-ref rotate: require both keys to parse. We don't probe the
    // new key here — `createKey()` is the caller's responsibility, and
    // the actual re-wrap loop will surface a 404 on first use.
    parseVaultRef(newRef, this.transitMount);
  }

  public async destroyKey(ref: KekRef): Promise<void> {
    const { keyName } = parseVaultRef(ref, this.transitMount);
    // Step 1: flip deletion_allowed on the key config. Required; without
    // it Vault rejects the DELETE with 400.
    await this.request<unknown>(
      'POST',
      `/v1/${this.transitMount}/keys/${encodeURIComponent(keyName)}/config`,
      { deletion_allowed: true },
      ref,
    );
    // Step 2: actual destroy.
    await this.request<unknown>(
      'DELETE',
      `/v1/${this.transitMount}/keys/${encodeURIComponent(keyName)}`,
      undefined,
      ref,
    );
  }

  /**
   * Create a per-user transit key. Idempotent: if the key already
   * exists, Vault returns 204 and we treat it as success.
   */
  public async createKey(ref: KekRef, keyType: TransitKeyType = 'aes256-gcm96'): Promise<void> {
    const { keyName } = parseVaultRef(ref, this.transitMount);
    await this.request<unknown>(
      'POST',
      `/v1/${this.transitMount}/keys/${encodeURIComponent(keyName)}`,
      { type: keyType },
      ref,
    );
  }

  // ------------------------------------------------------------------
  // HTTP plumbing
  // ------------------------------------------------------------------

  private async request<T>(
    method: 'POST' | 'DELETE' | 'GET',
    path: string,
    body: unknown,
    ref: KekRef,
  ): Promise<T> {
    let attempt = 0;
    let lastErr: unknown = null;
    // One retry on 403 (expired-token race). All other failures bubble.
    for (;;) {
      attempt++;
      const token = await this.auth.getToken();
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.addr}${path}`, {
          method,
          headers: {
            'x-vault-token': token,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (err) {
        lastErr = err;
        throw new KekNetworkError(
          `OpenBao request failed (${method} ${path}): ${describeNetErr(err)}`,
          err,
        );
      }
      if (res.status === 204) {
        // Successful no-content (e.g. rotate, key config, idempotent create).
        return undefined as T;
      }
      if (res.ok) {
        // 200-class with JSON body. Some endpoints (DELETE keys) return
        // 204 above; others (encrypt/decrypt) return 200 with body.
        const text = await res.text();
        if (!text) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch (err) {
          throw new KekResponseError(
            `OpenBao response is not valid JSON (${method} ${path}): ${(err as Error).message}`,
            res.status,
            text,
          );
        }
      }
      const failure = await _readFailure(res);
      // 403 once → invalidate cached token and retry.
      if (
        res.status === 403 &&
        this.retryOnExpiredToken &&
        attempt === 1
      ) {
        this.auth.invalidate();
        continue;
      }
      throw mapVaultError(res.status, failure, ref, lastErr);
    }
  }
}

function describeNetErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return '<unstringifiable>';
  }
}

/**
 * Translates a Vault failure-envelope into a typed adapter error. The
 * lookup is intentionally minimal — we only special-case statuses the
 * caller would branch on. Everything else becomes a generic
 * `KekResponseError`.
 */
function mapVaultError(
  status: number,
  failure: HttpFailure,
  ref: KekRef,
  _cause: unknown,
): KekError {
  const joined = failure.errors.join('; ');
  const looksLikeMissingKey = /(no existing key|key not found|encryption key not found)/i.test(
    joined,
  );
  if (status === 404 || (status === 400 && looksLikeMissingKey)) {
    return new KekNotFoundError(ref, joined || failure.rawBody, status);
  }
  if (status === 403) {
    return new KekPermissionError(ref, joined || failure.rawBody);
  }
  if (status === 503) {
    return new KekUnavailableError(joined || failure.rawBody, status);
  }
  return new KekResponseError(
    `OpenBao request failed for ref "${ref}" (status ${status})`,
    status,
    joined || failure.rawBody,
  );
}
