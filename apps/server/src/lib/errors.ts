/**
 * Fehler-Modell + HTTP-Mapping.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3 (Auth-Errors), §6 (Audit-Log).
 *
 * `AppError` ist die Basis. `HttpError` traegt zusaetzlich `status`. Der
 * globale Error-Handler ([../middleware/error-handler.ts]) mappt diese auf
 * JSON-Responses und emittet bei Bedarf einen Audit-Log-Eintrag.
 */
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'internal'
  | 'invite_expired'
  | 'invite_email_mismatch'
  | 'invite_already_used'
  | 'session_revoked'
  | 'refresh_replay_detected'
  | 'webauthn_challenge_mismatch'
  | 'webauthn_verification_failed'
  | 'bootstrap_only';

export interface ErrorDetail {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export class HttpError extends AppError {
  public readonly status: ContentfulStatusCode;

  constructor(
    status: ContentfulStatusCode,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, details);
    this.name = 'HttpError';
    this.status = status;
  }

  static badRequest(code: ErrorCode, msg: string, details?: Record<string, unknown>): HttpError {
    return new HttpError(400, code, msg, details);
  }
  static unauthorized(msg = 'unauthorized', details?: Record<string, unknown>): HttpError {
    return new HttpError(401, 'unauthorized', msg, details);
  }
  static forbidden(
    codeOrMsg: ErrorCode | string = 'forbidden',
    msgOrDetails?: string | Record<string, unknown>,
    maybeDetails?: Record<string, unknown>,
  ): HttpError {
    // Overload-Form 1: forbidden(message, details?)
    // Overload-Form 2: forbidden(code, message, details?)
    const KNOWN_CODES: ReadonlyArray<ErrorCode> = [
      'forbidden',
      'invite_email_mismatch',
      'bootstrap_only',
    ];
    if (typeof msgOrDetails === 'string' && KNOWN_CODES.includes(codeOrMsg as ErrorCode)) {
      return new HttpError(403, codeOrMsg as ErrorCode, msgOrDetails, maybeDetails);
    }
    const msg = typeof codeOrMsg === 'string' ? codeOrMsg : 'forbidden';
    const details = typeof msgOrDetails === 'object' && msgOrDetails !== null ? msgOrDetails : undefined;
    return new HttpError(403, 'forbidden', msg, details);
  }
  static notFound(msg = 'not_found', details?: Record<string, unknown>): HttpError {
    return new HttpError(404, 'not_found', msg, details);
  }
  static conflict(msg = 'conflict', details?: Record<string, unknown>): HttpError {
    return new HttpError(409, 'conflict', msg, details);
  }
}

export function errorToResponse(err: unknown): { status: ContentfulStatusCode; body: { error: ErrorDetail } } {
  if (err instanceof HttpError) {
    const detail: ErrorDetail = err.details
      ? { code: err.code, message: err.message, details: err.details }
      : { code: err.code, message: err.message };
    return {
      status: err.status,
      body: { error: detail },
    };
  }
  if (err instanceof AppError) {
    const detail: ErrorDetail = err.details
      ? { code: err.code, message: err.message, details: err.details }
      : { code: err.code, message: err.message };
    return {
      status: 500,
      body: { error: detail },
    };
  }
  const message = err instanceof Error ? err.message : 'internal_error';
  return {
    status: 500,
    body: { error: { code: 'internal', message } },
  };
}
