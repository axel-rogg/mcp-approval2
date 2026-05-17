/**
 * Cross-Subdomain-Cookie-Helper.
 *
 * Multi-Origin-Setup: PWA auf `app2.ai-toolhub.org`, API auf
 * `mcp2.ai-toolhub.org`. Cookies muessen von beiden Subdomains lesbar sein
 * — setCookie ohne `domain` scoped sie auf den exact-host und der
 * OAuth-Flow scheitert (Cookie auf app2 gesetzt, Callback auf mcp2
 * sieht es nicht → "missing oauth state cookie").
 *
 * Verwendung in Routes:
 *   import { authCookieOpts, refreshCookieOpts } from '../lib/cookie.js';
 *   setCookie(c, 'oauth_state', payload, authCookieOpts(config, { maxAge: 600 }));
 *   setCookie(c, 'refresh_token', token, refreshCookieOpts(config));
 *   deleteCookie(c, 'oauth_state', deleteCookieOpts(config));
 *
 * Pflicht: dieselben `domain` + `path` Werte auf SET + DELETE — sonst
 * delete loescht nicht (Browser sieht es als anderes Cookie).
 */

import type { AppConfig } from './config.js';

interface CookieOptsInput {
  readonly maxAge?: number;
  readonly sameSite?: 'Lax' | 'Strict' | 'None';
}

interface CookieOptsOutput {
  httpOnly: true;
  secure: boolean;
  sameSite: 'Lax' | 'Strict' | 'None';
  path: '/';
  maxAge?: number;
  domain?: string;
}

/**
 * Basis-Optionen fuer alle Auth-/Session-Cookies. SameSite=Lax weil OAuth-
 * Redirect-Flow das Cookie nach dem Google-Redirect zurueckschicken muss
 * (Strict wuerde blocken). HttpOnly + Secure (in prod) sind Pflicht.
 */
export function authCookieOpts(
  config: Pick<AppConfig, 'NODE_ENV' | 'COOKIE_DOMAIN'>,
  opts: CookieOptsInput = {},
): CookieOptsOutput {
  const out: CookieOptsOutput = {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: opts.sameSite ?? 'Lax',
    path: '/',
  };
  if (opts.maxAge !== undefined) out.maxAge = opts.maxAge;
  if (config.COOKIE_DOMAIN) out.domain = config.COOKIE_DOMAIN;
  return out;
}

/**
 * Delete-Optionen — muessen `domain` + `path` matchen den ursprueglichen
 * Set-Aufruf, sonst loescht der Browser das Cookie nicht (er sieht es als
 * unterschiedliches Cookie). maxAge wird vom hono-Helper auf 0 gesetzt.
 */
export function deleteCookieOpts(
  config: Pick<AppConfig, 'COOKIE_DOMAIN'>,
): { path: '/'; domain?: string } {
  const out: { path: '/'; domain?: string } = { path: '/' };
  if (config.COOKIE_DOMAIN) out.domain = config.COOKIE_DOMAIN;
  return out;
}
