/**
 * VertexAuth — Service-Account-Token-Lifecycle.
 *
 * Plan-Ref: PLAN-architecture-v1.md §8 (AI-Provider Google Vertex AI).
 *
 * Flow (RFC 7523 JWT-Bearer fuer Service-Accounts):
 *   1. Sign ein selbstausgestelltes JWT (RS256) mit dem Service-Account
 *      `private_key`. Claims: iss=client_email, scope=cloud-platform,
 *      aud=token_uri, exp=now+1h.
 *   2. POST das JWT als `assertion`-Form-Field an `token_uri`
 *      (https://oauth2.googleapis.com/token), grant_type =
 *      urn:ietf:params:oauth:grant-type:jwt-bearer.
 *   3. Response: access_token + expires_in.
 *   4. Cache in-memory, refresh 60s vor Ablauf.
 *
 * Wir nutzen die `jose`-Library (in @mcp-approval2/core re-exported, aber hier
 * direkt importiert weil ein leichter Layer fuer einen Adapter-Hot-Path).
 *
 * In-Worker-Variante (Cloudflare): `jose` laeuft auch dort, weil es WebCrypto
 * nutzt. Self-Host Node nutzt dieselbe API.
 *
 * Sicherheits-Hinweis: private_key wird hier in-memory als PKCS#8-PEM-Text
 * gehalten. Der Service-Account-Key sollte aus der credentials-Tabelle
 * (Bootstrap-Sonderfall, vault-encrypted at rest) gelesen werden — der
 * VertexAuth-Konstruktor bekommt das JSON-Object schon decrypted.
 */
import { SignJWT, importPKCS8 } from 'jose';
import type { ServiceAccountJson, VertexOauthTokenResponse } from './vertex-types.js';

export interface VertexAuthOptions {
  readonly serviceAccountJson: ServiceAccountJson;
  /**
   * Vertex-Scope. Default: `https://www.googleapis.com/auth/cloud-platform`.
   * Overridable falls man fuer billing/usage-API spaeter andere Scopes braucht.
   */
  readonly scope?: string;
  /** Custom fetch (fuer Tests). */
  readonly fetchImpl?: typeof fetch;
  /** Custom clock (fuer Tests). Default Date.now(). */
  readonly now?: () => number;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

const DEFAULT_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
/** Refresh-Vorlauf: 60s vor Ablauf den Token neu holen. */
const REFRESH_LEAD_MS = 60_000;
/** Self-issued JWT TTL: 1h (Google empfiehlt max 1h). */
const JWT_TTL_SEC = 3600;

export class VertexAuth {
  private readonly serviceAccount: ServiceAccountJson;
  private readonly scope: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cachedToken: CachedToken | null = null;
  private pendingFetch: Promise<string> | null = null;

  constructor(opts: VertexAuthOptions) {
    this.serviceAccount = opts.serviceAccountJson;
    this.scope = opts.scope ?? DEFAULT_SCOPE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? ((): number => Date.now());
  }

  /**
   * Liefert ein gueltiges Access-Token. Cached, refresht wenn <60s TTL.
   *
   * Concurrent-Safe: wenn waehrend eines laufenden Refreshes ein weiterer Call
   * kommt, attacht der auf das selbe Promise (kein doppelter Token-Exchange).
   */
  async getAccessToken(): Promise<string> {
    const now = this.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + REFRESH_LEAD_MS) {
      return this.cachedToken.token;
    }
    if (this.pendingFetch) {
      return this.pendingFetch;
    }
    this.pendingFetch = this.refresh();
    try {
      return await this.pendingFetch;
    } finally {
      this.pendingFetch = null;
    }
  }

  /** Test-only: Cache loeschen. */
  resetForTest(): void {
    this.cachedToken = null;
    this.pendingFetch = null;
  }

  private async refresh(): Promise<string> {
    const assertion = await this.signAssertion();
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });

    const response = await this.fetchImpl(this.serviceAccount.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `VertexAuth: token exchange failed (${response.status}): ${text.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as VertexOauthTokenResponse;
    if (!data.access_token || typeof data.expires_in !== 'number') {
      throw new Error('VertexAuth: malformed token response');
    }

    const expiresAt = this.now() + data.expires_in * 1000;
    this.cachedToken = { token: data.access_token, expiresAt };
    return data.access_token;
  }

  private async signAssertion(): Promise<string> {
    const privateKey = await importPKCS8(this.serviceAccount.private_key, 'RS256');
    const iatSec = Math.floor(this.now() / 1000);
    const jwt = await new SignJWT({
      scope: this.scope,
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.serviceAccount.client_email)
      .setAudience(this.serviceAccount.token_uri)
      .setIssuedAt(iatSec)
      .setExpirationTime(iatSec + JWT_TTL_SEC)
      .sign(privateKey);
    return jwt;
  }
}
