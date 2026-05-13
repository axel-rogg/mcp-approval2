/**
 * Public surface of @mcp-approval2/core/crypto.
 *
 * Web-Crypto-API-based primitives that run identically on Node 20+ and
 * Cloudflare Workers. Pure functions, no global state.
 */

export {
  aesGcmEncrypt,
  aesGcmDecrypt,
  type AesGcmEncryptArgs,
  type AesGcmEncryptResult,
  type AesGcmDecryptArgs,
} from './aes-gcm.js';

export {
  hkdfSha256,
  hkdfSha256Sync,
  deriveRecordKey,
  deriveAuditKey,
} from './hkdf.js';

export {
  buildAad,
  aadBytes,
  type AadInput,
  type AadRecordType,
  type CredentialsAad,
  type SessionAad,
  type AuditAad,
  type ObjectAad,
  type GenericAad,
} from './aad.js';

export { randomBytes, randomUuidV4, randomUlid } from './random.js';

export {
  signJwt,
  verifyJwt,
  type JwtAlg,
  type SignJwtArgs,
  type VerifyJwtArgs,
  type VerifyJwtResult,
} from './jwt.js';

export { xorPrfDek, xorBytes, PRF_DEK_LEN } from './prf-xor.js';
