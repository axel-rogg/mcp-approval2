/**
 * Globaler Error-Handler.
 *
 * Mapped Errors aus dem Routen-Layer via `errorToResponse` auf JSON. Ergaenzt
 * die Antwort mit `requestId` (PLAN §6 Audit-Korrelation).
 */
import type { ErrorHandler } from 'hono';
import type { AppBindings } from '../lib/context.js';
import { errorToResponse } from '../lib/errors.js';

export function errorHandler(): ErrorHandler<AppBindings> {
  return (err, c) => {
    const { status, body } = errorToResponse(err);
    const requestId = c.get('requestId');
    return c.json(
      {
        ...body,
        requestId,
      },
      status,
    );
  };
}
