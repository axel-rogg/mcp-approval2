/**
 * Knowledge-Adapter Error-Modell.
 *
 * Server-Seite emittiert RFC 7807 Problem Details (D-1, application/problem+json):
 *   { type: <URI>, title: <human msg>, status: <int>, detail?: <string>,
 *     instance?: <request-id>, ...extra }
 *
 * Wir mappen `status` → konkrete Subclass und `type` (URI-Pfad-Suffix) → `code`:
 *   400 → ValidationError       (Schema-Fehler, Caller-Fehler)
 *   401 → AuthError             (JWT abgelaufen / signature mismatch / service token)
 *   403 → PermissionError       (Owner-/Share-Constraint verletzt)
 *   404 → NotFoundError         (Resource existiert nicht oder fuer User unsichtbar)
 *   409 → ConflictError         (Idempotenz / CAS-Verletzung)
 *   429 → RateLimitError        (Quota / Throttling)
 *   5xx → ServiceError          (transient — Caller darf retry)
 *
 * Backwards-Compat:
 *   Wir parsen ZUSAETZLICH auch das alte `{ error: { code, message, details } }`-
 *   Format, damit aelterer Server-Code (oder zwischengeschaltete Proxies) nicht
 *   gleich zu Plain-Text bodyText.slice degradieren.
 *
 * Alle Subclasses tragen `code` (string, machine-readable) + `status` (HTTP-Code)
 * + optional `requestId` (correlation) + optional `details` (extra fields).
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
 * RFC 7807 Problem Detail (server-Seitig auch fuer 4xx/5xx). Reserved-Felder
 * sind `type`, `title`, `status`, `detail`, `instance` — alles andere wird
 * als `details` zurueckgegeben.
 */
interface ProblemDetail {
  readonly type?: string;
  readonly title?: string;
  readonly status?: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly [extra: string]: unknown;
}

/**
 * Legacy-Body-Shape (alter Hub bzw. zwischengeschaltete Proxies):
 *   { error: { code: string; message: string; details?: object } }
 */
interface LegacyErrorEnvelope {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: Record<string, unknown>;
  };
}

/**
 * Extrahiert `code` aus einem Problem-`type`-URI. Beispiel:
 *   "https://problems.knowledge2/quota-exceeded" → "quota-exceeded"
 *   "about:blank"                                → "about_blank"
 *   undefined                                    → fallback
 */
function codeFromProblemType(type: string | undefined, fallback: string): string {
  if (!type) return fallback;
  if (type === 'about:blank') return 'about_blank';
  // URI-suffix nach letztem '/'
  const slash = type.lastIndexOf('/');
  const suffix = slash >= 0 ? type.slice(slash + 1) : type;
  return suffix || fallback;
}

/**
 * Mappt einen HTTP-Status + Body-Hint auf den passenden Error-Class.
 *
 * Bevorzugte Body-Formate:
 *   1. RFC 7807 `{ type, title, status, detail, instance, ... }`
 *   2. Legacy `{ error: { code, message, details } }`
 *   3. Plain-Text body (genommen als message-fallback)
 */
export function errorFromResponse(args: {
  status: number;
  bodyText: string;
  requestId?: string;
}): KnowledgeError {
  const { status, bodyText, requestId } = args;

  let problem: ProblemDetail | undefined;
  let legacy: LegacyErrorEnvelope | undefined;
  try {
    const parsed = JSON.parse(bodyText) as ProblemDetail & LegacyErrorEnvelope;
    // Heuristik: RFC-7807 erkennbar an `title` ODER `type` ODER `status`.
    if (
      typeof parsed.title === 'string' ||
      typeof parsed.type === 'string' ||
      typeof parsed.status === 'number' ||
      typeof parsed.detail === 'string' ||
      typeof parsed.instance === 'string'
    ) {
      problem = parsed;
    }
    if (parsed.error !== undefined) {
      legacy = parsed;
    }
  } catch {
    // bodyText war kein JSON — wir nehmen den Plain-Text als message-Fallback.
  }

  // Message: prefer problem.title (+detail) → legacy.message → plain-text.
  let message: string;
  if (problem?.title) {
    message = problem.detail ? `${problem.title}: ${problem.detail}` : problem.title;
  } else if (legacy?.error?.message) {
    message = legacy.error.message;
  } else {
    message = bodyText.slice(0, 500) || `http ${status}`;
  }

  // Details: problem extra-fields (alles ausser title/type/status/detail/instance)
  // ODER legacy.error.details.
  let details: Record<string, unknown> | undefined;
  if (problem) {
    const extras: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(problem)) {
      if (k === 'type' || k === 'title' || k === 'status' || k === 'detail' || k === 'instance') continue;
      extras[k] = v;
    }
    if (Object.keys(extras).length > 0) details = extras;
  } else if (legacy?.error?.details) {
    details = legacy.error.details;
  }

  // Final requestId: prefer problem.instance (server-set) ueber header-fallback.
  const finalRequestId =
    (typeof problem?.instance === 'string' ? problem.instance : undefined) ?? requestId;

  // Code: problem-type-suffix > legacy.code > status-derived default
  const statusDefault = defaultCodeForStatus(status);
  const code = legacy?.error?.code ?? codeFromProblemType(problem?.type, statusDefault);

  // Status-class mapping. Code wird ueber `code`-Field (KnowledgeError.code)
  // transportiert; die konkrete Subclass haengt am Status.
  if (status === 400) return withCode(new ValidationError(message, finalRequestId, details), code);
  if (status === 401) return withCode(new AuthError(message, finalRequestId, details), code);
  if (status === 403) return withCode(new PermissionError(message, finalRequestId, details), code);
  if (status === 404) return withCode(new NotFoundError(message, finalRequestId, details), code);
  if (status === 409) return withCode(new ConflictError(message, finalRequestId, details), code);
  if (status === 429) return withCode(new RateLimitError(message, finalRequestId, details), code);
  return withCode(new ServiceError(message, status, finalRequestId, details), code);
}

function defaultCodeForStatus(status: number): string {
  if (status === 400) return 'validation_failed';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  return 'service_error';
}

/**
 * KnowledgeError.code ist `readonly` — wir muessen via `Object.defineProperty`
 * den extracted code ueberschreiben, sonst koennen wir nicht die Problem-
 * URI-Klasse durchtransportieren.
 */
function withCode<E extends KnowledgeError>(err: E, code: string): E {
  if (err.code !== code) {
    Object.defineProperty(err, 'code', { value: code, writable: false, configurable: true });
  }
  return err;
}
