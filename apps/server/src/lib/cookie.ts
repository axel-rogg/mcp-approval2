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
 * Entscheidet ob die konfigurierte COOKIE_DOMAIN fuer eine Request-Origin
 * gilt. Multi-Origin-Setup (Coop-Bypass via fly.dev): COOKIE_DOMAIN ist auf
 * ai-toolhub.org gescoped damit mcp2 + app2 sich Cookies teilen, aber
 * Requests von fly.dev darf das NICHT gesetzt bekommen — Browser verwirft
 * sonst das Cookie silently weil Domain != Host-Suffix.
 *
 * Returns true wenn Origin-Host auf COOKIE_DOMAIN endet (oder identisch).
 * Returns false wenn Origin nicht zur Cookie-Domain passt → host-scoped
 * Cookie als Fallback.
 */
function cookieDomainAppliesTo(cookieDomain: string, requestOrigin?: string): boolean {
  if (!cookieDomain) return false;
  if (!requestOrigin) return true; // legacy callers ohne Origin-Awareness
  let host: string;
  try {
    host = new URL(requestOrigin).hostname;
  } catch {
    return false;
  }
  // Strip leading dot if present (`.ai-toolhub.org` → `ai-toolhub.org`)
  const cd = cookieDomain.replace(/^\./, '');
  return host === cd || host.endsWith(`.${cd}`);
}

/**
 * Basis-Optionen fuer alle Auth-/Session-Cookies. SameSite=Lax weil OAuth-
 * Redirect-Flow das Cookie nach dem Google-Redirect zurueckschicken muss
 * (Strict wuerde blocken). HttpOnly + Secure (in prod) sind Pflicht.
 *
 * Multi-Origin: wenn `requestOrigin` uebergeben wird, wird die COOKIE_DOMAIN
 * nur gesetzt wenn die Origin tatsaechlich zu dieser Domain passt. Fly.dev-
 * Origins bekommen ein host-scoped Cookie (kein Domain-Attribut) damit der
 * Browser es nicht verwirft.
 */
export function authCookieOpts(
  config: Pick<AppConfig, 'NODE_ENV' | 'COOKIE_DOMAIN'>,
  opts: CookieOptsInput & { requestOrigin?: string } = {},
): CookieOptsOutput {
  const out: CookieOptsOutput = {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: opts.sameSite ?? 'Lax',
    path: '/',
  };
  if (opts.maxAge !== undefined) out.maxAge = opts.maxAge;
  if (cookieDomainAppliesTo(config.COOKIE_DOMAIN, opts.requestOrigin)) {
    out.domain = config.COOKIE_DOMAIN;
  }
  return out;
}

/**
 * Delete-Optionen — muessen `domain` + `path` matchen den ursprueglichen
 * Set-Aufruf, sonst loescht der Browser das Cookie nicht (er sieht es als
 * unterschiedliches Cookie). maxAge wird vom hono-Helper auf 0 gesetzt.
 *
 * Origin-Awareness wie bei authCookieOpts: requestOrigin entscheidet ob
 * COOKIE_DOMAIN gesetzt wird oder das Cookie host-scoped geloescht wird.
 */
export function deleteCookieOpts(
  config: Pick<AppConfig, 'COOKIE_DOMAIN'>,
  opts: { requestOrigin?: string } = {},
): { path: '/'; domain?: string } {
  const out: { path: '/'; domain?: string } = { path: '/' };
  if (cookieDomainAppliesTo(config.COOKIE_DOMAIN, opts.requestOrigin)) {
    out.domain = config.COOKIE_DOMAIN;
  }
  return out;
}
