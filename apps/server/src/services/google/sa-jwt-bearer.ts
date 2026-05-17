/**
 * Google Service-Account JWT-Bearer-Grant.
 *
 * Plan-Ref: PLAN-multiuser-subMcp-auth.md, Sprint 2026-05-18 (gcloud-Pfad).
 *
 * Tauscht ein Service-Account-JSON (per-User in user_sub_mcp_config ablegt)
 * in einen kurzlebigen `access_token`. approval2 leitet danach nur noch den
 * `access_token` an den gcloud-Worker weiter (nicht mehr den Private-Key).
 *
 * Vorher (katastrophal): Das volle SA-JSON wurde als X-GCP-SA-JSON-Header
 * bei JEDEM Tool-Call durch die Leitung gesendet (~1.6 KB inkl.
 * Private-Key). Edge-Proxies, Logging, Cache-Server konnten den Key
 * captureren obwohl er at-rest verschluesselt lag.
 *
 * Jetzt: approval2 macht das JWT-Signing lokal mit `jose`, tauscht beim
 * Google-Token-Endpoint in einen access_token (1h TTL, 50 min cached),
 * sendet nur noch den Bearer-Token. Private-Key verbleibt im approval2-
 * Prozess (encrypted at-rest, in-memory bei Refresh).
 *
 * RFC 7523 §2.1 + Google-Docs:
 *   https://developers.google.com/identity/protocols/oauth2/service-account#authorizingrequests
 */
import { SignJWT, importPKCS8 } from 'jose';

/** Parsed Service-Account-JSON. Minimal-Subset der Google-Felder. */
export interface ServiceAccountKey {
  readonly client_email: string;
  readonly private_key: string; // PEM PKCS8
  readonly token_uri: string;
  readonly project_id?: string;
  /** Optional: SA-eigene key_id wandert in JWT-Header.kid (Audit-Trail bei Google). */
  readonly private_key_id?: string;
}

export interface SaAccessTokenResult {
  readonly accessToken: string;
  readonly expiresInSec: number;
  readonly projectId: string | null;
}

/**
 * Parsen + minimal-Validierung. Wirft mit klarer Operator-Anleitung wenn das
 * SA-JSON unvollstaendig ist (User-uploaded → kann verstuemmelt sein).
 */
export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Service-Account JSON parsing failed: ${err instanceof Error ? err.message : String(err)}. ` +
        'Erwartet ist die JSON-Datei aus GCP-Console → IAM → Service Accounts → Keys.',
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Service-Account JSON ist kein Objekt');
  }
  const obj = parsed as Record<string, unknown>;
  const clientEmail = obj['client_email'];
  const privateKey = obj['private_key'];
  const tokenUri = obj['token_uri'];
  const projectId = obj['project_id'];
  const privateKeyId = obj['private_key_id'];
  if (typeof clientEmail !== 'string' || clientEmail.length === 0) {
    throw new Error('Service-Account JSON fehlt client_email');
  }
  if (typeof privateKey !== 'string' || !privateKey.includes('BEGIN') || !privateKey.includes('PRIVATE KEY')) {
    throw new Error('Service-Account JSON fehlt valid private_key (PEM PKCS8)');
  }
  return {
    client_email: clientEmail,
    private_key: privateKey,
    token_uri: typeof tokenUri === 'string' && tokenUri.length > 0 ? tokenUri : 'https://oauth2.googleapis.com/token',
    ...(typeof projectId === 'string' ? { project_id: projectId } : {}),
    ...(typeof privateKeyId === 'string' ? { private_key_id: privateKeyId } : {}),
  };
}

export interface RequestSaAccessTokenArgs {
  readonly sa: ServiceAccountKey;
  /** Scope-Liste, space-separated. Default: cloud-platform (Vertex/GCP-APIs). */
  readonly scopes?: ReadonlyArray<string>;
  /** Override fuer Tests. */
  readonly fetchImpl?: typeof fetch;
  /** Override fuer Tests. */
  readonly now?: () => number;
}

const DEFAULT_GCP_SCOPES: ReadonlyArray<string> = ['https://www.googleapis.com/auth/cloud-platform'];

/**
 * Macht einen JWT-Bearer-Grant gegen den Google-Token-Endpoint und liefert
 * den access_token zurueck. Caller cached selbst (siehe gcp-sa-token-cache.ts).
 */
export async function requestSaAccessToken(
  args: RequestSaAccessTokenArgs,
): Promise<SaAccessTokenResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const now = args.now ?? (() => Date.now());
  const scopes = args.scopes ?? DEFAULT_GCP_SCOPES;
  const iat = Math.floor(now() / 1000);
  const exp = iat + 3600; // Google akzeptiert max 1h Lifetime; wir nutzen das voll.

  const normalizedPem = normalizePem(args.sa.private_key);
  const privateKey = await importPKCS8(normalizedPem, 'RS256');

  const jwtBuilder = new SignJWT({ scope: scopes.join(' ') })
    .setProtectedHeader(
      args.sa.private_key_id
        ? { alg: 'RS256', typ: 'JWT', kid: args.sa.private_key_id }
        : { alg: 'RS256', typ: 'JWT' },
    )
    .setIssuer(args.sa.client_email)
    .setSubject(args.sa.client_email)
    .setAudience(args.sa.token_uri)
    .setIssuedAt(iat)
    .setExpirationTime(exp);

  const assertion = await jwtBuilder.sign(privateKey);

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const resp = await fetchImpl(args.sa.token_uri, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`google-sa-jwt-bearer failed: HTTP ${resp.status} ${errText.slice(0, 300)}`);
  }
  const json = (await resp.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (json.error || !json.access_token) {
    throw new Error(
      `google-sa-jwt-bearer error: ${json.error ?? 'no_access_token'} ${json.error_description ?? ''}`.trim(),
    );
  }
  return {
    accessToken: json.access_token,
    expiresInSec: typeof json.expires_in === 'number' ? json.expires_in : 3600,
    projectId: args.sa.project_id ?? null,
  };
}

function normalizePem(pem: string): string {
  let s = pem.trim();
  if (s.includes('\\n')) s = s.replace(/\\n/g, '\n');
  return s;
}
