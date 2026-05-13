/**
 * OpenBaoKekProvider — Stub.
 *
 * Wird in Burst 2 (Phase 2 — Credentials + Vault, Woche 5-7) implementiert.
 *
 * Plan-Reference: docs/plans/active/PLAN-architecture-v1.md §5.2.
 *
 * Geplante Implementation:
 *   - HTTP-Client gegen `https://openbao:8200`
 *   - AppRole-Auth: role_id (statisch) + secret_id (rotated via Cron)
 *   - Per-User-Key: `transit/keys/user-<userId>` mit `type=aes256-gcm96`,
 *     `derived=false`, `deletion_allowed=true`
 *   - wrap   → POST /v1/transit/encrypt/user-<userId>
 *              body: { plaintext: base64(dek) }
 *              → "vault:v1:<b64>"-String
 *   - unwrap → POST /v1/transit/decrypt/user-<userId>
 *              body: { ciphertext: "vault:v1:<b64>" }
 *              → plaintext: base64(dek)
 *   - rotate → POST /v1/transit/keys/user-<userId>/rotate (interne
 *              Versionierung; ref bleibt gleich); aber unsere Interface-
 *              Variante (oldRef -> newRef) ist fuer KEK-URI-Wechsel
 *              gedacht und ruft re-encrypt-Endpoint pro Ciphertext.
 *   - destroyKey → DELETE /v1/transit/keys/user-<userId>
 *                  (vorher Update mit deletion_allowed=true)
 *
 * Auth-Flow:
 *   1. POST /v1/auth/approle/login { role_id, secret_id }
 *      → client_token (TTL 1h)
 *   2. client_token wird in-memory gehalten; bei 403 auto-retry mit
 *      neuem Login.
 *   3. secret_id-Rotation per Cron (taeglich): GET /v1/auth/approle/role/
 *      <role>/secret-id rotiert das Secret im Vault, neuer Wert wird
 *      in Env-Var/Secret-Manager geschrieben.
 *
 * Crypto-Shred-Semantik:
 *   - destroyKey loescht das Key-Material in OpenBao Transit.
 *   - Spaeter unwrap() einer Ciphertext-Reference mit destroyed key
 *     → OpenBao 400, Adapter wirft `KekRefDestroyedError`.
 *   - Es gibt KEINE Recovery — das ist der Punkt von Crypto-Shredding.
 */

import type { KekProvider, KekRef } from './interface.js';

export interface OpenBaoKekProviderOptions {
  /** z.B. `https://openbao.internal:8200`. */
  readonly endpoint: string;
  /** Mount-Path der Transit-Engine. Default: `transit`. */
  readonly transitMount?: string;
  /** AppRole role_id. */
  readonly roleId: string;
  /** AppRole secret_id — rotiert via Cron. */
  readonly secretId: string;
  /** Optional injected fetch (fuer Tests). Default: globalThis.fetch. */
  readonly fetch?: typeof fetch;
}

const NOT_IMPL_MSG =
  'OpenBaoKekProvider: not implemented in Phase 0. ' +
  'Wird in Burst 2 (Phase 2 — Credentials + Vault) vollstaendig ' +
  'gemaess PLAN-architecture-v1 §5.2.';

export class OpenBaoKekProvider implements KekProvider {
  private readonly endpoint: string;
  private readonly transitMount: string;
  private readonly roleId: string;
  private readonly secretId: string;
  private readonly fetchFn: typeof fetch;

  public constructor(opts: OpenBaoKekProviderOptions) {
    this.endpoint = opts.endpoint;
    this.transitMount = opts.transitMount ?? 'transit';
    this.roleId = opts.roleId;
    this.secretId = opts.secretId;
    this.fetchFn = opts.fetch ?? fetch;
    // Constructor erlaubt: wir wollen die Klasse instanziieren
    // koennen (Wiring-Tests), aber jeder Call wirft.
    void this.endpoint;
    void this.transitMount;
    void this.roleId;
    void this.secretId;
    void this.fetchFn;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async wrap(_dek: Uint8Array, _ref: KekRef): Promise<Uint8Array> {
    // TODO Burst 2: POST /v1/{transitMount}/encrypt/<keyName>
    // body: { plaintext: base64(dek) }
    // Response: { data: { ciphertext: "vault:v1:<b64>" } }
    // Encode the "vault:v1:..."-String als UTF-8-Bytes fuer DB-Storage.
    return Promise.reject(new Error(NOT_IMPL_MSG));
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async unwrap(_wrapped: Uint8Array, _ref: KekRef): Promise<Uint8Array> {
    // TODO Burst 2: POST /v1/{transitMount}/decrypt/<keyName>
    // body: { ciphertext: utf8-decoded(wrapped) }
    // Response: { data: { plaintext: base64(dek) } }
    return Promise.reject(new Error(NOT_IMPL_MSG));
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async rotate(_oldRef: KekRef, _newRef: KekRef): Promise<void> {
    // TODO Burst 2: zwei Wege je nach Semantik:
    //   a) oldRef === newRef: POST /v1/{transitMount}/keys/<keyName>/rotate
    //      (interne Versionierung)
    //   b) oldRef !== newRef: pro Ciphertext call POST .../decrypt/<oldKey>
    //      gefolgt von POST .../encrypt/<newKey>. Caller muss alle
    //      credentials-Rows iterieren.
    return Promise.reject(new Error(NOT_IMPL_MSG));
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async destroyKey(_ref: KekRef): Promise<void> {
    // TODO Burst 2:
    //   1. POST /v1/{transitMount}/keys/<keyName>/config
    //      body: { deletion_allowed: true }
    //   2. DELETE /v1/{transitMount}/keys/<keyName>
    // EDPB-konform fuer GDPR Art. 17.
    return Promise.reject(new Error(NOT_IMPL_MSG));
  }
}
