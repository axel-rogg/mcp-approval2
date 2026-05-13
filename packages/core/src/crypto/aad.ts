/**
 * AAD (Additional Authenticated Data) builder for AES-GCM.
 *
 * AAD strings are deterministic, pipe-separated, and bound to a record-type
 * discriminator. This prevents cross-domain replay (e.g. a credentials-ciphertext
 * cannot be decrypted with a session-AAD, even if keys happened to match).
 *
 * Conventions (mirrored from PLAN-architecture-v1.md §5.1):
 *   credentials|{owner_id}|{provider}|{kind}|{credential_id}
 *   session|{user_id}|{session_id}
 *   audit|{event_id}|{request_id}
 *   object|{owner_id}|{kind}|{subtype}|{object_id}
 *   generic|{namespace}|{id}
 */

const enc = new TextEncoder();

/** All record-types we issue AADs for. Closed enum on purpose. */
export type AadRecordType =
  | 'credentials'
  | 'session'
  | 'audit'
  | 'object'
  | 'generic';

export interface CredentialsAad {
  recordType: 'credentials';
  owner: string;
  provider: string;
  kind: string;
  id: string;
}

export interface SessionAad {
  recordType: 'session';
  userId: string;
  sessionId: string;
}

export interface AuditAad {
  recordType: 'audit';
  eventId: string;
  requestId: string;
}

export interface ObjectAad {
  recordType: 'object';
  owner: string;
  kind: string;
  subtype: string;
  id: string;
}

export interface GenericAad {
  recordType: 'generic';
  namespace: string;
  id: string;
}

export type AadInput =
  | CredentialsAad
  | SessionAad
  | AuditAad
  | ObjectAad
  | GenericAad;

/**
 * Build a deterministic AAD string.
 *
 * Empty / undefined fields are forbidden — every component must be a non-empty
 * string. This forces callers to be explicit and avoids accidental ambiguity
 * (e.g. `credentials||jira|...` colliding with a different shape).
 */
export function buildAad(input: AadInput): string {
  switch (input.recordType) {
    case 'credentials':
      assertNonEmpty('owner', input.owner);
      assertNonEmpty('provider', input.provider);
      assertNonEmpty('kind', input.kind);
      assertNonEmpty('id', input.id);
      return `credentials|${input.owner}|${input.provider}|${input.kind}|${input.id}`;

    case 'session':
      assertNonEmpty('userId', input.userId);
      assertNonEmpty('sessionId', input.sessionId);
      return `session|${input.userId}|${input.sessionId}`;

    case 'audit':
      assertNonEmpty('eventId', input.eventId);
      assertNonEmpty('requestId', input.requestId);
      return `audit|${input.eventId}|${input.requestId}`;

    case 'object':
      assertNonEmpty('owner', input.owner);
      assertNonEmpty('kind', input.kind);
      assertNonEmpty('subtype', input.subtype);
      assertNonEmpty('id', input.id);
      return `object|${input.owner}|${input.kind}|${input.subtype}|${input.id}`;

    case 'generic':
      assertNonEmpty('namespace', input.namespace);
      assertNonEmpty('id', input.id);
      return `generic|${input.namespace}|${input.id}`;
  }
}

/** Encode an AAD string (or pass-through bytes) to bytes for Web-Crypto. */
export function aadBytes(aad: string | Uint8Array): Uint8Array {
  if (typeof aad === 'string') return enc.encode(aad);
  return aad;
}

function assertNonEmpty(field: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`buildAad: field "${field}" must be a non-empty string`);
  }
  if (value.includes('|')) {
    throw new Error(
      `buildAad: field "${field}" must not contain pipe character (got: ${JSON.stringify(value)})`,
    );
  }
}
