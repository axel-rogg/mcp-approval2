/**
 * Request-Logging-Middleware.
 *
 * Plan-Ref: PLAN-architecture-v1.md §6 (Audit + Observability).
 *
 * Verantwortung:
 *   - Pro Request einen child-Logger anhaengen (`c.set('logger', ...)`).
 *   - Request-In + Response-Out loggen mit Method, Path, Status, Duration.
 *   - Header-Whitelist (user-agent, accept, content-type) — NIE Authorization
 *     oder Cookies loggen, NIE Body, keine Query-Strings mit Token-Resten.
 *
 * Was hier NICHT passiert:
 *   - Audit-Logging (siehe `services/audit.ts` / `audit-sink.ts`). Audit ist
 *     business-event, dies hier ist HTTP-Operations.
 *   - PII-Filter ueber Path — Caller-IP loggen wir, weil das fuer Rate-Limit-
 *     Forensik gebraucht wird; PII-Email steht nirgends im Path.
 */
import type { MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';
import type { AppBindings } from '../lib/context.js';
import { withRequestId } from '../lib/logger.js';

/**
 * Erweitert `AppBindings.Variables` (siehe `lib/context.ts`) um `logger`. Wir
 * deklarieren das hier per Module-Augmentation, damit Routen einfach
 * `c.get('logger')` abrufen koennen.
 *
 * NB: Module-Augmentation auf `AppBindings` selbst ist nicht moeglich, weil
 * AppBindings ein konkretes Interface ist (nicht generic). Stattdessen
 * exportieren wir den Helper-Type + Routen casten via `(c.var as
 * LoggerBindings).logger` falls noetig — in der Praxis ist `c.get('logger')`
 * untyped Hono-Get, der einen `unknown` liefert; Routen koennen auch direkt
 * `withRequestId(c.get('requestId'))` aufrufen und brauchen die Variable
 * nicht.
 */
export interface LoggerBindings {
  Variables: {
    logger: Logger;
  };
}

/**
 * Whitelist von Headern, die im Log auftauchen duerfen. Authorization,
 * Cookie, set-cookie + alles was Secrets transportiert ist explizit
 * ausgeschlossen (zusaetzlich zur pino-Redact-Liste).
 */
const SAFE_HEADERS = [
  'user-agent',
  'accept',
  'content-type',
  'content-length',
  'x-forwarded-for',
  'x-real-ip',
] as const;

interface SafeHeaders {
  readonly [key: string]: string | undefined;
}

function pickSafeHeaders(req: Request): SafeHeaders {
  const out: Record<string, string | undefined> = {};
  for (const name of SAFE_HEADERS) {
    const v = req.headers.get(name);
    if (v) out[name] = v;
  }
  return out;
}

/**
 * Pfad ohne Query-String. Query-Strings koennen Token oder PII enthalten
 * (z.B. ?email=…); wir loggen sie nur als boolean `has_query`.
 */
function safePath(rawPath: string): { path: string; has_query: boolean } {
  const qi = rawPath.indexOf('?');
  if (qi < 0) return { path: rawPath, has_query: false };
  return { path: rawPath.slice(0, qi), has_query: true };
}

export interface LogMiddlewareOptions {
  /**
   * Wenn `true`, wird auch der Response-Body-Length geloggt (nur die Zahl).
   * Default: `true`. Nicht teuer, weil Hono das automatisch in den Headers
   * hat.
   */
  readonly logResponseSize?: boolean;
  /**
   * Paths die geskipped werden (z.B. /healthz). Match per startsWith. Default:
   * `['/healthz', '/readyz', '/livez']` — Health-Probes sind hochfrequent +
   * uninteressant.
   */
  readonly skipPaths?: ReadonlyArray<string>;
}

const DEFAULT_SKIP = ['/healthz', '/readyz', '/livez'] as const;

/**
 * Hono-Middleware. Ordnung: nach `requestId()`, vor `errorHandler()`. Setzt
 * `c.var.logger` und loggt Request-In + Response-Out.
 */
export function logRequests(options: LogMiddlewareOptions = {}): MiddlewareHandler<AppBindings> {
  const { logResponseSize = true, skipPaths = DEFAULT_SKIP } = options;
  return async (c, next) => {
    const requestId = c.get('requestId');
    const log = withRequestId(requestId);
    // Variable in den Hono-Kontext schreiben — Routen koennen sie via
    // `c.get('logger' as never) as Logger` lesen, ohne dass AppBindings extra
    // wissen muss.
    (c as unknown as { set: (k: string, v: unknown) => void }).set('logger', log);

    const url = c.req.url;
    const method = c.req.method;
    const path = new URL(url).pathname;

    if (skipPaths.some((p) => path.startsWith(p))) {
      await next();
      return;
    }

    const { path: cleanPath, has_query } = safePath(path);
    const startedAt = performance.now();

    log.info(
      {
        event: 'http.request.in',
        method,
        path: cleanPath,
        has_query,
        headers: pickSafeHeaders(c.req.raw),
      },
      'http.in',
    );

    let errored = false;
    try {
      await next();
    } catch (err) {
      errored = true;
      const duration_ms = Math.round(performance.now() - startedAt);
      log.error(
        {
          event: 'http.request.error',
          method,
          path: cleanPath,
          duration_ms,
          err: err instanceof Error ? { name: err.name, message: err.message } : { value: String(err) },
        },
        'http.err',
      );
      throw err;
    } finally {
      if (!errored) {
        const duration_ms = Math.round(performance.now() - startedAt);
        const status = c.res?.status ?? 0;
        const contentLength = logResponseSize
          ? c.res?.headers.get('content-length') ?? null
          : null;
        const fields: Record<string, unknown> = {
          event: 'http.request.out',
          method,
          path: cleanPath,
          status,
          duration_ms,
        };
        if (contentLength !== null) fields['content_length'] = Number(contentLength) || null;
        // Wir loggen 4xx als warn, 5xx als error, sonst info.
        const lvl = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
        log[lvl](fields, 'http.out');
      }
    }
  };
}
