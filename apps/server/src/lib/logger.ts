/**
 * Structured Logger (pino).
 *
 * Plan-Ref: PLAN-architecture-v1.md §6 (Audit + Observability).
 *
 * Verantwortung:
 *   - JSON-Logger fuer Production (line-delimited NDJSON, SIEM-freundlich).
 *   - Pflicht-Redaction fuer Secrets (password / token / dek / refresh /
 *     client_secret / private_key). NIEMALS Body / Credential-Ciphertext loggen.
 *   - Per-Request Child-Logger via `withRequestId(requestId)` — verbindet die
 *     Request-ID aus `middleware/request-id.ts` mit jeder Log-Line.
 *
 * Was hier NICHT passiert:
 *   - Audit-Log → das ist ein separater Sink (`services/audit-sink.ts`).
 *     Audit ist immutable+structured, Logger ist Operations-Tooling.
 *   - PII-Klartext im Klartext-Field — alles was potenziell PII enthalten kann
 *     (email, displayName) muss vom Caller maskiert werden, der Logger
 *     redact-Map kann das nicht erkennen.
 */
import pino, { type Logger } from 'pino';

/**
 * Basis-Logger. NICHT direkt in Routen-Code verwenden — immer via
 * `withRequestId(c.get('requestId'))` ein child-Logger erzeugen, sonst fehlt
 * die Korrelations-ID.
 *
 * Env-Vars:
 *   - LOG_LEVEL — 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'.
 *     Default 'info'. In Tests gerne 'silent'.
 *   - NODE_ENV — bestimmt das Output-Format: 'production' → JSON-NDJSON,
 *     sonst pino-default (kompakt mit Newlines, kein pino-pretty-Zwang).
 */
export const baseLogger: Logger = pino({
  level: process.env['LOG_LEVEL'] ?? (process.env['NODE_ENV'] === 'test' ? 'silent' : 'info'),
  formatters: {
    level: (label) => ({ level: label }),
  },
  serializers: pino.stdSerializers,
  // Redaction: deep-paths fuer typische Secret-Felder. `*.X` matched X in
  // jedem nested object, `*` matched alle top-level keys.
  // WICHTIG: redact-paths sind nicht regex; sie sind glob-style mit `*`.
  redact: {
    paths: [
      '*.password',
      '*.secret',
      '*.token',
      '*.dek',
      '*.dek_b64',
      '*.refresh_token',
      '*.access_token',
      '*.id_token',
      '*.private_key',
      '*.private_key_pem',
      '*.client_secret',
      '*.master_key',
      '*.master_key_base64',
      '*.ciphertext',
      '*.wrapped_dek',
      'password',
      'secret',
      'token',
      'refresh_token',
      'access_token',
      'private_key',
      'private_key_pem',
      'client_secret',
      'master_key',
      'master_key_base64',
      'authorization',
      'headers.authorization',
      'headers.cookie',
      'headers["set-cookie"]',
    ],
    censor: '[REDACTED]',
  },
  // base-fields stehen in jeder Log-Line; service + env helfen beim SIEM-Filter.
  base: {
    service: 'mcp-approval2-server',
    env: process.env['NODE_ENV'] ?? 'development',
  },
  // ISO-8601-Timestamp ist SIEM-Standard. pino-default ist Epoch-ms.
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Child-Logger fuer einen Request. Alle Routen + Services bekommen ueber
 * `c.get('logger')` (gesetzt von `middleware/log.ts`) eine Instance, die
 * `request_id` als Bound-Field traegt.
 *
 * Beispiel:
 *   ```ts
 *   const log = withRequestId(c.get('requestId'));
 *   log.info({ user_id: u.id }, 'session.refresh.success');
 *   ```
 */
export function withRequestId(requestId: string): Logger {
  return baseLogger.child({ request_id: requestId });
}

/**
 * Test-Hilfsfunktion — gibt einen Silent-Logger zurueck, damit Tests keine
 * Stdout-Pollution erzeugen. Wird nicht von Produktiv-Code benutzt.
 */
export function makeSilentLogger(): Logger {
  return pino({ level: 'silent' });
}

export type { Logger };
