/**
 * UserServerOAuthService — OAuth-Authorize-Flow fuer Sub-MCP-Server.
 *
 * Plan-Ref: docs/plans/active/PLAN-per-user-server-store.md (Phase 3).
 *
 * Pattern (pre-registered, single supported mode per User-Decision Q3):
 *   1. User traegt client_id + client_secret in user_sub_mcp_config ein
 *      (oder hat das gemacht wenn `_oauth_client_id`/`_oauth_client_secret`
 *      Felder im Worker-config_schema deklariert sind).
 *   2. User klickt "Authorize" → POST /v1/me/servers/:name/oauth/start
 *   3. Service generiert CSRF-state + PKCE-code-verifier, persistiert in
 *      user_sub_mcp_oauth_state (TTL 10 min), returnt authorizeUrl.
 *   4. PWA setzt window.location.href = authorizeUrl. User-Browser geht zu
 *      Provider-OAuth-Page (z.B. accounts.google.com), Consent, redirect
 *      zu approval2-callback.
 *   5. PWA-Callback-Route ruft POST /v1/me/servers/:name/oauth/callback
 *      mit {state, code}. Service verifiziert state, tauscht code via
 *      configured token_url, speichert refresh_token KMS-encrypted in
 *      user_sub_mcp_config[`_oauth_refresh_token`].
 *
 * Config-Schema-Quelle: sub_mcp_servers.config_schema._meta.oauth aus
 * tools/list — enthaelt provider, scopes, authorize_url, token_url.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { DbAdapter } from '@mcp-approval2/adapters';
import { HttpError } from '../lib/errors.js';
import type { SubMcpRegistry } from '../mcp/gateway/registry.js';
import type { UserServerConfigService } from './user-server-config.js';

const STATE_TTL_MS = 10 * 60 * 1000; // 10 min
const CODE_VERIFIER_LENGTH = 64;
const STATE_LENGTH = 32;

export interface OAuthSchemaMeta {
  readonly provider?: string;
  readonly kind?: 'pre' | 'dcr';
  readonly scopes?: ReadonlyArray<string>;
  readonly authorize_url?: string;
  readonly token_url?: string;
}

export interface OAuthStartResult {
  readonly authorizeUrl: string;
  readonly state: string;
}

export interface UserServerOAuthService {
  /** Generiert authorizeUrl + state, persistiert Pending-Row. */
  start(userId: string, subMcpName: string, redirectUri: string): Promise<OAuthStartResult>;
  /**
   * Verifiziert state, tauscht code → refresh_token, speichert in
   * user_sub_mcp_config. Loescht die Pending-Row.
   */
  callback(userId: string, subMcpName: string, state: string, code: string): Promise<void>;
  /** Cleanup expired states (Cron-Task). */
  cleanupExpired(): Promise<number>;
}

function base64UrlEncode(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generateState(): string {
  return base64UrlEncode(randomBytes(STATE_LENGTH));
}

function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(CODE_VERIFIER_LENGTH));
}

function computeCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier).digest());
}

export interface UserServerOAuthServiceOpts {
  readonly db: DbAdapter;
  readonly registry: SubMcpRegistry;
  readonly config: UserServerConfigService;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

interface OAuthStateRow {
  readonly state: string;
  readonly user_id: string;
  readonly sub_mcp_name: string;
  readonly code_verifier: string;
  readonly redirect_uri: string;
  readonly created_at: number | string;
  readonly expires_at: number | string;
}

export function createUserServerOAuthService(
  opts: UserServerOAuthServiceOpts,
): UserServerOAuthService {
  const { db, registry, config } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());

  async function getOAuthSchema(subMcpName: string): Promise<OAuthSchemaMeta> {
    const cfg = await registry.getByName(subMcpName).catch(() => null);
    if (!cfg) throw HttpError.notFound(`server '${subMcpName}' not found`);
    const schema = cfg.configSchema as { oauth?: OAuthSchemaMeta } | null;
    if (!schema?.oauth) {
      throw HttpError.badRequest(
        'invalid_request',
        `server '${subMcpName}' declares no oauth schema`,
      );
    }
    return schema.oauth;
  }

  return {
    async start(userId, subMcpName, redirectUri) {
      const oauth = await getOAuthSchema(subMcpName);
      if (!oauth.authorize_url) {
        throw HttpError.badRequest(
          'invalid_request',
          `server '${subMcpName}' has no authorize_url`,
        );
      }
      if (oauth.kind === 'dcr') {
        throw HttpError.badRequest(
          'invalid_request',
          'DCR-mode not supported in Phase 3 (User-Decision Q3: pre-registered only)',
        );
      }
      // Pre-registered: User muss client_id + (optional) client_secret schon
      // in user_sub_mcp_config eingetragen haben.
      const userConfig = await config.getAllValues(userId, subMcpName);
      const clientId = userConfig.get('_oauth_client_id') ?? userConfig.get('client_id');
      if (!clientId) {
        throw HttpError.badRequest(
          'invalid_request',
          `client_id missing — bitte unter Konfigurieren "_oauth_client_id" eintragen`,
        );
      }
      const verifier = generateCodeVerifier();
      const challenge = computeCodeChallenge(verifier);
      const state = generateState();
      const ts = now();
      const expiresAt = ts + STATE_TTL_MS;

      // ⚠️ Pool-Hygiene: db.transaction() statt db.scoped() — letzteres
      // leaked Connections. Siehe user-subscriptions.ts.
      await db.transaction(userId, async (scoped) => {
        await scoped.query(
          `INSERT INTO user_sub_mcp_oauth_state
             (state, user_id, sub_mcp_name, code_verifier, redirect_uri,
              created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [state, userId, subMcpName, verifier, redirectUri, ts, expiresAt],
        );
      });

      const url = new URL(oauth.authorize_url);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      if (oauth.scopes && oauth.scopes.length > 0) {
        url.searchParams.set('scope', oauth.scopes.join(' '));
      }
      // Provider-Specifics: nur Google versteht access_type=offline + prompt=consent.
      // Cloudflare's MCP-OAuth + GitHub + andere geben sonst 500 server_error
      // wenn man ihnen unbekannte query params schickt.
      // (Bug-Fix 2026-05-17 nach cf-Authorize-Fail).
      const provider = oauth.provider?.toLowerCase() ?? '';
      const isGoogle = provider.includes('google') || (oauth.authorize_url ?? '').includes('accounts.google.com');
      if (isGoogle) {
        url.searchParams.set('access_type', 'offline');
        url.searchParams.set('prompt', 'consent');
      }

      return { authorizeUrl: url.toString(), state };
    },

    async callback(userId, subMcpName, state, code) {
      // Pool-Hygiene: state-Row in eigener Transaction lesen + ggf. expire-
      // cleanup. Token-Exchange (langer extern-Fetch) und finale state-row-
      // Loeschung passieren danach in separater Transaction — wir wollen
      // keine offene DB-Tx halten waehrend wir auf den OAuth-Provider warten.
      const row = await db.transaction(userId, async (scoped) => {
        const rows = await scoped.query<OAuthStateRow>(
          `SELECT state, user_id, sub_mcp_name, code_verifier, redirect_uri,
                  created_at, expires_at
             FROM user_sub_mcp_oauth_state
            WHERE state = $1 AND user_id = $2 AND sub_mcp_name = $3
            LIMIT 1`,
          [state, userId, subMcpName],
        );
        const r = rows[0];
        if (!r) return null;
        const exp = typeof r.expires_at === 'number' ? r.expires_at : Number(r.expires_at);
        if (exp < now()) {
          await scoped.query(`DELETE FROM user_sub_mcp_oauth_state WHERE state = $1`, [state]);
          return 'expired' as const;
        }
        return r;
      });
      if (!row) {
        throw HttpError.unauthorized('oauth_state_invalid');
      }
      if (row === 'expired') {
        throw HttpError.unauthorized('oauth_state_expired');
      }

      // Token-Exchange
      const oauth = await getOAuthSchema(subMcpName);
      if (!oauth.token_url) {
        throw HttpError.badRequest('invalid_request', 'token_url missing in schema');
      }
      const userConfig = await config.getAllValues(userId, subMcpName);
      const clientId = userConfig.get('_oauth_client_id') ?? userConfig.get('client_id');
      const clientSecret = userConfig.get('_oauth_client_secret');
      if (!clientId) {
        throw HttpError.badRequest('invalid_request', 'client_id missing');
      }

      const tokenBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: row.redirect_uri,
        client_id: clientId,
        code_verifier: row.code_verifier,
      });
      if (clientSecret) {
        tokenBody.set('client_secret', clientSecret);
      }

      const resp = await fetchImpl(oauth.token_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: tokenBody.toString(),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new HttpError(
          502,
          'internal',
          `oauth token-exchange failed: HTTP ${resp.status} ${text.slice(0, 200)}`,
        );
      }
      const tokenJson = (await resp.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        token_type?: string;
      };
      if (!tokenJson.refresh_token) {
        throw HttpError.badRequest(
          'invalid_request',
          'token-exchange returned no refresh_token (offline-access fehlt?)',
        );
      }

      // Persistieren KMS-encrypted in user_sub_mcp_config
      await config.set(userId, subMcpName, '_oauth_refresh_token', tokenJson.refresh_token);
      if (tokenJson.access_token) {
        await config.set(userId, subMcpName, '_oauth_access_token', tokenJson.access_token);
      }
      if (typeof tokenJson.expires_in === 'number') {
        const expiresAt = now() + tokenJson.expires_in * 1000;
        await config.set(userId, subMcpName, '_oauth_access_token_expires_at', String(expiresAt));
      }

      // State-Row loeschen (single-use). Eigene Transaction damit kein
      // db.scoped()-Leak entsteht.
      await db.transaction(userId, async (scoped) => {
        await scoped.query(`DELETE FROM user_sub_mcp_oauth_state WHERE state = $1`, [state]);
      });
    },

    async cleanupExpired() {
      const raw = db.unsafe('oauth_state_cleanup');
      const result = await raw.query<{ count: number }>(
        `WITH del AS (
          DELETE FROM user_sub_mcp_oauth_state WHERE expires_at < $1 RETURNING 1
        ) SELECT COUNT(*)::int AS count FROM del`,
        [now()],
      );
      return result[0]?.count ?? 0;
    },
  };
}
