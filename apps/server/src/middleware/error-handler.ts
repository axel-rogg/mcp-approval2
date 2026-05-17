/**
 * Globaler Error-Handler.
 *
 * Mapped Errors aus dem Routen-Layer via `errorToResponse` auf JSON. Ergaenzt
 * die Antwort mit `requestId` (PLAN §6 Audit-Korrelation).
 *
 * LOGGING (2026-05-17): vorher swallowed errorHandler die Errors silent —
 * nur die JSON-Response ging zum Client, server-side stand nichts im Log.
 * Das machte Debugging von 500ern unmoeglich (z.B. "Cannot read properties
 * of undefined (reading 'parsers')" Bug). Jetzt:
 *   - 5xx: vollstaendige stack-trace + request-context auf stderr (pino error)
 *   - 4xx: kurze warn-Zeile mit code+message (genug fuer Drift-Diagnose,
 *     kein noise bei Standard-401/404)
 *   - HTTP-Method+Path+RequestId immer mit dabei → korreliert mit
 *     http.request.in/out aus middleware/log.ts
 */
import type { ErrorHandler } from 'hono';
import type { AppBindings } from '../lib/context.js';
import { errorToResponse, HttpError } from '../lib/errors.js';
import { withRequestId } from '../lib/logger.js';

export function errorHandler(): ErrorHandler<AppBindings> {
  return (err, c) => {
    const { status, body } = errorToResponse(err);
    const requestId = c.get('requestId');
    const log = withRequestId(requestId);

    const method = c.req.method;
    const path = (() => {
      try {
        return new URL(c.req.url).pathname;
      } catch {
        return c.req.url;
      }
    })();

    if (status >= 500) {
      // 5xx → echter Server-Bug. Stack + Errorklasse + Request-Kontext
      // unbedingt loggen, sonst rate ich wo der Fehler herkommt.
      log.error(
        {
          event: 'http.request.5xx',
          method,
          path,
          status,
          code: body.error.code,
          err: serializeErr(err),
        },
        'http.5xx',
      );
    } else if (status >= 400 && !(err instanceof HttpError && err.code === 'unauthorized')) {
      // 4xx → meistens Client-Fehler. Kurz loggen, kein Stack.
      // unauthorized wird intentional ausgenommen (Auth-Probes sind hochfrequent).
      log.warn(
        {
          event: 'http.request.4xx',
          method,
          path,
          status,
          code: body.error.code,
          message: body.error.message,
        },
        'http.4xx',
      );
    }

    return c.json({ ...body, requestId }, status);
  };
}

/**
 * Serialize an unknown error to a JSON-loggable shape including stack.
 */
function serializeErr(err: unknown): {
  name: string;
  message: string;
  stack?: string;
  cause?: string;
} {
  if (err instanceof Error) {
    const out: { name: string; message: string; stack?: string; cause?: string } = {
      name: err.name,
      message: err.message,
    };
    if (err.stack) out.stack = err.stack;
    if (err.cause) out.cause = String(err.cause);
    return out;
  }
  return { name: 'Unknown', message: String(err) };
}
