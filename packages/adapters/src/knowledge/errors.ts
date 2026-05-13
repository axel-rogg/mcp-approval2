/**
 * Knowledge-Adapter Error-Modell.
 *
 * HTTP-Status → Error-Class-Mapping:
 *   400 → ValidationError       (Schema-Fehler, Caller-Fehler)
 *   401 → AuthError             (JWT abgelaufen / signature mismatch)
 *   403 → PermissionError       (Owner-/Share-Constraint verletzt)
 *   404 → NotFoundError         (Resource existiert nicht oder fuer User unsichtbar)
 *   409 → ConflictError         (Idempotenz / CAS-Verletzung)
 *   429 → RateLimitError        (Throttling vom Storage-Service)
 *   5xx → ServiceError          (transient — Caller darf retry)
 *
 * Alle Subclasses tragen `code` (string, machine-readable) + `status` (HTTP-Code).
 */

export class KnowledgeError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly requestId: string | undefined;
  public readonly details: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message: string,
    status: number,
    requestId?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'KnowledgeError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.details = details;
  }
}

export class ValidationError extends KnowledgeError {
  constructor(message: string, requestId?: string, details?: Record<string, unknown>) {
    super('validation_failed', message, 400, requestId, details);
    this.name = 'ValidationError';
  }
}

export class AuthError extends KnowledgeError {
  constructor(message = 'unauthorized', requestId?: string, details?: Record<string, unknown>) {
    super('unauthorized', message, 401, requestId, details);
    this.name = 'AuthError';
  }
}

export class PermissionError extends KnowledgeError {
  constructor(message = 'forbidden', requestId?: string, details?: Record<string, unknown>) {
    super('forbidden', message, 403, requestId, details);
    this.name = 'PermissionError';
  }
}

export class NotFoundError extends KnowledgeError {
  constructor(message = 'not_found', requestId?: string, details?: Record<string, unknown>) {
    super('not_found', message, 404, requestId, details);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends KnowledgeError {
  constructor(message = 'conflict', requestId?: string, details?: Record<string, unknown>) {
    super('conflict', message, 409, requestId, details);
    this.name = 'ConflictError';
  }
}

export class RateLimitError extends KnowledgeError {
  constructor(message = 'rate_limited', requestId?: string, details?: Record<string, unknown>) {
    super('rate_limited', message, 429, requestId, details);
    this.name = 'RateLimitError';
  }
}

export class ServiceError extends KnowledgeError {
  constructor(
    message: string,
    status = 502,
    requestId?: string,
    details?: Record<string, unknown>,
  ) {
    super('service_error', message, status, requestId, details);
    this.name = 'ServiceError';
  }
}

/**
 * Mappt einen HTTP-Status + Body-Hint auf den passenden Error-Class.
 * Body-Format-Erwartung (mcp-knowledge2-Konvention):
 *   { error: { code: string; message: string; details?: object } }
 */
export function errorFromResponse(args: {
  status: number;
  bodyText: string;
  requestId?: string;
}): KnowledgeError {
  const { status, bodyText, requestId } = args;
  let parsed: { error?: { code?: string; message?: string; details?: Record<string, unknown> } } = {};
  try {
    parsed = JSON.parse(bodyText) as typeof parsed;
  } catch {
    // bodyText war kein JSON — wir nehmen den Plain-Text als message.
  }
  const message = parsed.error?.message ?? (bodyText.slice(0, 500) || `http ${status}`);
  const details = parsed.error?.details;

  if (status === 400) return new ValidationError(message, requestId, details);
  if (status === 401) return new AuthError(message, requestId, details);
  if (status === 403) return new PermissionError(message, requestId, details);
  if (status === 404) return new NotFoundError(message, requestId, details);
  if (status === 409) return new ConflictError(message, requestId, details);
  if (status === 429) return new RateLimitError(message, requestId, details);
  return new ServiceError(message, status, requestId, details);
}
