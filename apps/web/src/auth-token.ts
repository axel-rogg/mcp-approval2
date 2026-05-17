/**
 * Shared Access-Token Store + Refresh-Helper.
 *
 * Problem das das loest: vor diesem Module hatte api.ts den access-token in
 * einer Closure-Variable versteckt, und die anderen Sub-Clients (api-apps,
 * api-storage, api-prefs, api-push) nutzten NUR Cookie — was fuer /v1/* nicht
 * reicht (Server-side `auth(server)` erwartet Bearer). Ergebnis: jede Surface
 * ausserhalb der Core-API war "missing bearer token".
 *
 * Loesung: Token + lastSession + refresh-inflight-promise in einem geteilten
 * Module-State. Alle API-Clients lesen `getAccessToken()` und bauen ihren
 * Authorization-Header. Bei 401 ruft jeder Client `refreshSession(base)` —
 * das ist intern dedupliziert (parallele Calls warten auf den ersten Refresh).
 *
 * Race-Sicherheit: Refresh-Token-Rotation im Server invalidiert beim ersten
 * Aufruf den alten Refresh. Wenn 5 Sub-Clients parallel 401 bekommen, darf
 * nur EINER /auth/refresh aufrufen — die anderen warten auf dasselbe Promise.
 */

export interface Session {
  readonly userId: string;
  readonly email: string;
  readonly role: 'admin' | 'member';
  readonly sessionId: string;
  readonly expiresAt: number;
}

interface RefreshResponseBody {
  accessToken: string;
  expiresAt: number;
  sessionId: string;
  user?: { id: string; email: string; role: 'admin' | 'member' };
}

let currentAccessToken: string | null = null;
let lastSession: Session | null = null;
let refreshInflight: Promise<Session | null> | null = null;

export function getAccessToken(): string | null {
  return currentAccessToken;
}

export function setAccessToken(token: string | null): void {
  currentAccessToken = token;
}

export function getLastSession(): Session | null {
  return lastSession;
}

export function clearSession(): void {
  currentAccessToken = null;
  lastSession = null;
}

/**
 * POST /auth/refresh — holt einen neuen Access-Token mit dem Refresh-Token-
 * Cookie. Setzt currentAccessToken + lastSession bei Erfolg. Parallele
 * Aufrufe sehen das gleiche Promise (Dedup, kritisch wegen
 * Refresh-Token-Rotation).
 *
 * @param baseUrl  Server-Origin (z.B. window.location.origin)
 * @returns die neue Session oder null wenn refresh fehlschlug
 */
export async function refreshSession(baseUrl: string): Promise<Session | null> {
  if (refreshInflight) return refreshInflight;
  refreshInflight = (async () => {
    try {
      const url = baseUrl.endsWith('/')
        ? `${baseUrl}auth/refresh`
        : `${baseUrl}/auth/refresh`;
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        clearSession();
        return null;
      }
      const body = (await res.json()) as RefreshResponseBody;
      currentAccessToken = body.accessToken;
      lastSession = {
        userId: body.user?.id ?? '',
        email: body.user?.email ?? '',
        role: body.user?.role ?? 'member',
        sessionId: body.sessionId,
        expiresAt: body.expiresAt,
      };
      return lastSession;
    } catch {
      clearSession();
      return null;
    } finally {
      refreshInflight = null;
    }
  })();
  return refreshInflight;
}

/**
 * Hilfs-Wrapper fuer Sub-Clients: macht einen authenticated fetch mit
 * automatischem 401-Retry nach refreshSession().
 *
 * Wenn `currentAccessToken === null` und kein Cookie da ist, klappt /auth/
 * refresh sowieso nicht → wir geben dem ersten Request den Versuch und
 * lassen den Caller mit dem 401 umgehen (Login-Redirect).
 */
export async function authedFetch(
  url: string,
  init: RequestInit,
  baseUrl: string,
): Promise<Response> {
  const headers = new Headers(init.headers);
  const tok = currentAccessToken;
  if (tok) headers.set('authorization', `Bearer ${tok}`);

  let res = await fetch(url, { ...init, headers, credentials: 'include' });
  if (res.status !== 401) return res;

  // 401: versuch einen Refresh, dann einen Retry — aber nur einmal.
  const fresh = await refreshSession(baseUrl);
  if (!fresh || !currentAccessToken) return res;

  const retryHeaders = new Headers(init.headers);
  retryHeaders.set('authorization', `Bearer ${currentAccessToken}`);
  res = await fetch(url, { ...init, headers: retryHeaders, credentials: 'include' });
  return res;
}
