/**
 * OAuth-Error-Response-Helper (RFC 6749 §5.2 + RFC 7591 §3.2.2).
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Phase 4.
 *
 * OAuth-Errors haben eine eigene JSON-Shape:
 *
 *   { "error": "<code>", "error_description"?: "<human>" }
 *
 * Anders als HttpError im Rest-API, NICHT { error: { code, message } }.
 * Wir bauen daher hier einen kleinen Helper statt errorToResponse zu reusen.
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppBindings } from '../../lib/context.js';
import type { OauthErrorCode } from './types.js';

export function oauthError(
  c: Context<AppBindings>,
  status: ContentfulStatusCode,
  code: OauthErrorCode,
  description?: string,
): Response {
  const body: { error: OauthErrorCode; error_description?: string } = { error: code };
  if (description) body.error_description = description;
  return c.json(body, status, {
    'cache-control': 'no-store',
    pragma: 'no-cache',
  });
}
