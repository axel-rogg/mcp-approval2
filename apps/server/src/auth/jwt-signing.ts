/**
 * RS256-Key-Pair-Manager fuer service-boundary JWTs.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2.1 (mcp-approval2 → mcp-knowledge2),
 *           §11 Phase 4 (JWKS-Discovery), ADR-0001 (DEK-Resolution).
 *
 * Verantwortung:
 *   - PEM-Loader (PKCS#8 private, SPKI public) → CryptoKey ueber `jose`.
 *   - In-Memory-Cache pro PEM-string (Web-Crypto-Import ist teuer).
 *   - Helpers `getSigningKey()` + `getJwksPublicKey()` + `getKid()` zum
 *     Single-Source-of-Truth fuer alle Konsumenten (KnowledgeService-
 *     Factory + JWKS-Endpoint).
 *   - Dev-Fallback: wenn weder Private- noch Public-PEM gesetzt sind, gibt
 *     `getSigningKey()` `null` zurueck — Caller (KnowledgeService-Factory,
 *     JWKS-Endpoint) muessen damit umgehen + auf HS256 / leere JWKS-Liste
 *     zurueckfallen. In Prod soll der Boot-Code Pflicht-Check fahren.
 *
 * Security:
 *   - Wir geben die CryptoKey-Handles `extractable=false` zurueck. Damit ist
 *     ein Leak ueber `exportKey()` unmoeglich. Public-Key ist extractable
 *     (JWK-Export-Pfad).
 *   - Cache-Key ist der gesamte PEM-string — rotationen via env-Tausch
 *     invalidieren den Cache automatisch beim naechsten Boot.
 */
import { importPKCS8, importSPKI, type KeyLike } from 'jose';

const PRIVATE_KEY_CACHE = new Map<string, Promise<CryptoKey>>();
const PUBLIC_KEY_CACHE = new Map<string, Promise<CryptoKey>>();

export interface JwtSigningEnv {
  readonly JWT_RS256_PRIVATE_KEY_PEM?: string;
  readonly JWT_RS256_PUBLIC_KEY_PEM?: string;
  readonly JWT_KID?: string;
}

/**
 * Holt den Signing-Private-Key. Wenn keine PEM gesetzt ist: `null` zurueck
 * (Dev-Fallback). Bei gesetzter PEM aber Parse-Fehler: throw.
 */
export async function getSigningKey(env: JwtSigningEnv): Promise<CryptoKey | null> {
  const pem = env.JWT_RS256_PRIVATE_KEY_PEM;
  if (!pem || pem.trim().length === 0) return null;
  return loadPrivateKey(pem);
}

/**
 * Holt den Verification-Public-Key. Wenn keine PEM gesetzt ist: `null`
 * zurueck. Wird vom JWKS-Endpoint genutzt.
 */
export async function getJwksPublicKey(env: JwtSigningEnv): Promise<CryptoKey | null> {
  const pem = env.JWT_RS256_PUBLIC_KEY_PEM;
  if (!pem || pem.trim().length === 0) return null;
  return loadPublicKey(pem);
}

/** Liefert die `kid`-Header-Wert oder `'default'`. */
export function getKid(env: JwtSigningEnv): string {
  const k = env.JWT_KID;
  return k && k.trim().length > 0 ? k : 'default';
}

/**
 * Boot-time check fuer Production: wirft, wenn die Service-Boundary-Keys
 * fehlen. Aufruf optional aus index.ts.
 */
export function assertRs256Configured(env: JwtSigningEnv): void {
  if (!env.JWT_RS256_PRIVATE_KEY_PEM) {
    throw new Error('JWT_RS256_PRIVATE_KEY_PEM not configured');
  }
  if (!env.JWT_RS256_PUBLIC_KEY_PEM) {
    throw new Error('JWT_RS256_PUBLIC_KEY_PEM not configured');
  }
}

async function loadPrivateKey(pem: string): Promise<CryptoKey> {
  let cached = PRIVATE_KEY_CACHE.get(pem);
  if (!cached) {
    cached = (async (): Promise<CryptoKey> => {
      const normalized = normalizePem(pem);
      const key = (await importPKCS8(normalized, 'RS256', {
        extractable: false,
      })) as KeyLike;
      return key as CryptoKey;
    })();
    cached.catch(() => PRIVATE_KEY_CACHE.delete(pem));
    PRIVATE_KEY_CACHE.set(pem, cached);
  }
  return cached;
}

async function loadPublicKey(pem: string): Promise<CryptoKey> {
  let cached = PUBLIC_KEY_CACHE.get(pem);
  if (!cached) {
    cached = (async (): Promise<CryptoKey> => {
      const normalized = normalizePem(pem);
      const key = (await importSPKI(normalized, 'RS256', {
        extractable: true,
      })) as KeyLike;
      return key as CryptoKey;
    })();
    cached.catch(() => PUBLIC_KEY_CACHE.delete(pem));
    PUBLIC_KEY_CACHE.set(pem, cached);
  }
  return cached;
}

/**
 * Env-Strings kommen oft mit `\n` escaped oder ohne Leerzeichen — wir bringen
 * sie in eine Form die `jose` parsen kann.
 */
function normalizePem(pem: string): string {
  let s = pem.trim();
  if (s.includes('\\n')) s = s.replace(/\\n/g, '\n');
  return s;
}

/** Test-Hook: caches leeren. NICHT in Production-Code aufrufen. */
export function _resetJwtSigningCacheForTests(): void {
  PRIVATE_KEY_CACHE.clear();
  PUBLIC_KEY_CACHE.clear();
}
