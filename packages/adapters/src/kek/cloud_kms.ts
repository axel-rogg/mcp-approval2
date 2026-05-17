/**
 * CloudKmsKekProvider — Google Cloud KMS wrapped master, HKDF-derived per-ref KEK.
 *
 * Pattern (analog zu mcp-knowledge2/src/adapters/kms/cloud_kms.ts):
 *   - Beim Boot wird ein *encrypted* master-key aus dem env entpackt:
 *     CLOUD_KMS_WRAPPED_MASTER_B64 (base64 ciphertext) wird via KMS.decrypt
 *     gegen CLOUD_KMS_KEY_NAME entschluesselt. Master-Plaintext lebt
 *     ausschliesslich im Prozess-RAM.
 *   - Per-ref KEK wird per HKDF-SHA-256(master, salt=utf8(ref), info=...)
 *     deterministisch abgeleitet — identisches Pattern wie LocalKekProvider,
 *     nur ist der Master nicht im Doppler-Plaintext sondern KMS-gewrappt.
 *   - destroyKey: in-memory Sperre wie LocalKekProvider. Echtes
 *     Crypto-Shredding pro User braucht per-user KMS-Keys (KMS-Rechnung
 *     skaliert dann linear) — fuer Pilot (3 Tester) ueberdimensioniert.
 *
 * Auth (ADC-Chain):
 *   1. GOOGLE_APPLICATION_CREDENTIALS_JSON (inline JSON in env) — Fly-Path
 *   2. GOOGLE_APPLICATION_CREDENTIALS (file path) — local dev
 *   3. Workload-Identity-Federation auf Cloud Run / GKE — future hardening
 *
 * Latency: ein einzelner KMS-Roundtrip beim allerersten wrap/unwrap-Call
 * (lazy bootstrap). Danach 100% in-process. KC2-Pendant macht das gleich.
 *
 * Rotation: wenn CLOUD_KMS_WRAPPED_MASTER_B64 in Doppler aktualisiert wird,
 * triggert das Service-Redeploy → frischer Master beim naechsten Boot.
 * KMS-Key-Rotation allein (auto-rotate 90d) rotiert den Master NICHT — das
 * braucht eine bewusste Re-Wrap-Aktion via gcloud kms encrypt + Doppler-Update.
 *
 * Plan-Reference: docs/privat.md §9.3 (Cloud-KMS-Variante).
 */

import { webcrypto as nodeWebCrypto } from 'node:crypto';

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

import type { KekProvider, KekRef } from './interface.js';

const HKDF_INFO = new TextEncoder().encode('mcp-approval2-kek-v1');
const NONCE_LEN = 12;
const KEK_LEN = 32;

const subtle: SubtleCrypto =
  (globalThis as typeof globalThis & { crypto?: Crypto }).crypto?.subtle ??
  nodeWebCrypto.subtle;

/**
 * Minimal-Interface fuer den Google-KMS-Client den wir brauchen. Bewusst
 * eng — vermeidet die ganze KeyManagementServiceClient-Typ-Surface.
 * Tests injizieren ein Fake-Object direkt.
 */
export interface CloudKmsDecryptClient {
  decrypt(req: {
    name: string;
    ciphertext: Buffer | Uint8Array;
  }): Promise<[{ plaintext?: Buffer | Uint8Array | null }]>;
}

export interface CloudKmsKekProviderOptions {
  /**
   * Voll-qualifizierter KMS-Key-Resource-Name. Format:
   *   projects/<PROJECT_ID>/locations/<LOC>/keyRings/<RING>/cryptoKeys/<KEY>
   * Wird vom TF-Apply als Doppler-Secret CLOUD_KMS_KEY_NAME geliefert.
   */
  readonly keyName: string;

  /**
   * Base64-encoded ciphertext des 32-byte Master-Keys, gewrappt unter
   * `keyName`. Wird vom TF-Apply (google_kms_secret_ciphertext) generiert
   * und als Doppler-Secret CLOUD_KMS_WRAPPED_MASTER_B64 geliefert.
   */
  readonly wrappedMasterB64: string;

  /**
   * KMS-Client. In Produktion: `new KeyManagementServiceClient()` aus
   * @google-cloud/kms (lazy in defaultClientFactory). In Tests: Fake.
   * Wir nehmen einen Factory damit der Import vom @google-cloud/kms
   * nur im Produktions-Pfad triggert (cold-start-Latenz).
   */
  readonly clientFactory?: () => Promise<CloudKmsDecryptClient>;
}

async function defaultClientFactory(): Promise<CloudKmsDecryptClient> {
  // Dynamic import: zieht das @google-cloud/kms-Modul (≈ 1 MB) nur dann
  // in den Bundle wenn dieser Provider aktiv ist.
  const { KeyManagementServiceClient } = await import('@google-cloud/kms');

  // Auth-Resolution (in Precedence-Reihenfolge):
  //   1. GOOGLE_APPLICATION_CREDENTIALS_JSON — inline JSON in env (Fly-Pattern,
  //      vom TF-Apply via doppler_secret.*_google_application_credentials_json
  //      eingespielt). NICHT Teil des Standard-ADC-Chains, deswegen explizit.
  //   2. GOOGLE_APPLICATION_CREDENTIALS — file-path (local dev, k8s-mounts)
  //   3. Metadata-Server / gcloud auth (Cloud Run, GCE, lokale Dev-Maschine)
  const inlineJson = process.env['GOOGLE_APPLICATION_CREDENTIALS_JSON'];
  if (inlineJson && inlineJson.trim().length > 0) {
    const parsed = parseSaJson(inlineJson);
    return new KeyManagementServiceClient({
      credentials: parsed,
      projectId: parsed.project_id,
    }) as unknown as CloudKmsDecryptClient;
  }

  // Fallback: Default-ADC-Chain (file-path env / metadata server / gcloud).
  return new KeyManagementServiceClient() as unknown as CloudKmsDecryptClient;
}

/**
 * Parse Service-Account-JSON. Akzeptiert:
 *   - Raw JSON-String         (KC2-Pattern: VERTEX_SERVICE_ACCOUNT_JSON)
 *   - Base64-encoded JSON     (TF-Default: google_service_account_key.private_key
 *                              ist base64-encoded JSON laut Provider-Doku)
 * Wirft wenn weder JSON-parseable noch base64+JSON-parseable.
 */
function parseSaJson(raw: string): {
  client_email: string;
  private_key: string;
  project_id: string;
} {
  // Erst: raw JSON probieren (Inline-Variante)
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed['client_email'] === 'string') {
      return parsed as unknown as ReturnType<typeof parseSaJson>;
    }
  } catch {
    /* fall through to base64 */
  }
  // Dann: base64-decoded JSON (TF-Provider-Default)
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    if (typeof parsed['client_email'] === 'string') {
      return parsed as unknown as ReturnType<typeof parseSaJson>;
    }
  } catch {
    /* fall through */
  }
  throw new Error(
    'CloudKmsKekProvider: GOOGLE_APPLICATION_CREDENTIALS_JSON ist weder valides ' +
      'JSON noch base64-encoded JSON mit client_email-Feld.',
  );
}

function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  const c =
    (globalThis as typeof globalThis & { crypto?: Crypto }).crypto ??
    nodeWebCrypto;
  c.getRandomValues(out);
  return out;
}

function deriveKek(masterKey: Uint8Array, ref: KekRef): Uint8Array {
  const salt = new TextEncoder().encode(ref);
  return hkdf(sha256, masterKey, salt, HKDF_INFO, KEK_LEN);
}

function toArrayBuffer(raw: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(raw.byteLength);
  copy.set(raw);
  return copy.buffer;
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey(
    'raw',
    toArrayBuffer(raw),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

export class CloudKmsKekProvider implements KekProvider {
  private readonly keyName: string;
  private readonly wrappedMasterB64: string;
  private readonly clientFactory: () => Promise<CloudKmsDecryptClient>;
  private readonly destroyed = new Set<KekRef>();
  private masterKey: Uint8Array | null = null;
  private inflightUnwrap: Promise<Uint8Array> | null = null;

  public constructor(opts: CloudKmsKekProviderOptions) {
    if (!opts.keyName) {
      throw new Error('CloudKmsKekProvider: keyName required');
    }
    if (!opts.wrappedMasterB64) {
      throw new Error('CloudKmsKekProvider: wrappedMasterB64 required');
    }
    this.keyName = opts.keyName;
    this.wrappedMasterB64 = opts.wrappedMasterB64;
    this.clientFactory = opts.clientFactory ?? defaultClientFactory;
  }

  public async wrap(dek: Uint8Array, ref: KekRef): Promise<Uint8Array> {
    this.assertAlive(ref);
    if (dek.byteLength === 0) {
      throw new Error('CloudKmsKekProvider.wrap: empty dek');
    }
    const master = await this.getMasterKey();
    const kek = deriveKek(master, ref);
    const key = await importAesKey(kek);
    const nonce = randomBytes(NONCE_LEN);
    const aad = new TextEncoder().encode(ref);
    const ctBuf = await subtle.encrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(aad) },
      key,
      toArrayBuffer(dek),
    );
    const ct = new Uint8Array(ctBuf);
    const out = new Uint8Array(NONCE_LEN + ct.byteLength);
    out.set(nonce, 0);
    out.set(ct, NONCE_LEN);
    return out;
  }

  public async unwrap(wrapped: Uint8Array, ref: KekRef): Promise<Uint8Array> {
    this.assertAlive(ref);
    if (wrapped.byteLength < NONCE_LEN + 16) {
      throw new Error(
        `CloudKmsKekProvider.unwrap: ciphertext too short (${wrapped.byteLength} bytes)`,
      );
    }
    const nonce = wrapped.subarray(0, NONCE_LEN);
    const ct = wrapped.subarray(NONCE_LEN);
    const master = await this.getMasterKey();
    const kek = deriveKek(master, ref);
    const key = await importAesKey(kek);
    const aad = new TextEncoder().encode(ref);
    const ptBuf = await subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(aad) },
      key,
      toArrayBuffer(ct),
    );
    return new Uint8Array(ptBuf);
  }

  public async rotate(oldRef: KekRef, newRef: KekRef): Promise<void> {
    this.assertAlive(oldRef);
    if (oldRef === newRef) return;
    return Promise.resolve();
  }

  public async destroyKey(ref: KekRef): Promise<void> {
    this.destroyed.add(ref);
    return Promise.resolve();
  }

  private assertAlive(ref: KekRef): void {
    if (this.destroyed.has(ref)) {
      throw new Error(
        `CloudKmsKekProvider: key ref "${ref}" is destroyed (crypto-shredded).`,
      );
    }
  }

  /**
   * Lazy master-key bootstrap. First call hits KMS.decrypt; subsequent
   * calls reuse the cached plaintext from process-memory. Concurrent
   * first-callers are dedup'd via `inflightUnwrap`.
   */
  private async getMasterKey(): Promise<Uint8Array> {
    if (this.masterKey) return this.masterKey;
    if (this.inflightUnwrap) return this.inflightUnwrap;
    this.inflightUnwrap = this.fetchMasterKey()
      .then((mk) => {
        this.masterKey = mk;
        return mk;
      })
      .finally(() => {
        this.inflightUnwrap = null;
      });
    return this.inflightUnwrap;
  }

  private async fetchMasterKey(): Promise<Uint8Array> {
    const client = await this.clientFactory();
    const ciphertext = Buffer.from(this.wrappedMasterB64, 'base64');
    const [resp] = await client.decrypt({
      name: this.keyName,
      ciphertext,
    });
    if (!resp.plaintext) {
      throw new Error('CloudKmsKekProvider: KMS decrypt returned empty plaintext');
    }
    const raw =
      resp.plaintext instanceof Uint8Array
        ? resp.plaintext
        : Buffer.from(resp.plaintext as unknown as ArrayBufferLike);
    if (raw.byteLength !== 32) {
      throw new Error(
        `CloudKmsKekProvider: unwrapped master must be 32 bytes (got ${raw.byteLength}). Re-wrap with 32-byte plaintext.`,
      );
    }
    return new Uint8Array(raw);
  }
}
