/**
 * Email-Adapter — pluggable Transport-Layer fuer transaktionale Emails.
 *
 * Use-Cases (Stand 2026-05-17, Phase Multi-User):
 *   - Invite-Email: Admin lädt Tester ein, System schickt Magic-Link
 *   - Recovery-Email: User hat Passkey verloren, bekommt Re-Auth-Link
 *
 * Backends:
 *   - Resend (production) — REST-API, ~3000 mails/month free
 *   - Console (dev / pilot-bootstrap) — loggt Email in stdout +
 *     persistiert in `email_outbox`-Tabelle, Admin liest sie via PWA-UI
 *     ab und stellt sie manuell zu (out-of-band) bis DNS verifiziert ist
 *
 * Auswahl ueber Env-Var `EMAIL_PROVIDER=resend|console`. Default
 * `console` damit ein Deploy ohne RESEND_API_KEY nicht fail-closed
 * stirbt.
 *
 * Sicherheit:
 *   - Adapter darf NIE die Recovery/Invite-Token loggen — der Caller
 *     setzt die Tokens in den html/text body ein, Logger sieht nur
 *     `subject` + `to`.
 *   - `from` ist Konfig-fix (z.B. noreply@ai-toolhub.org); Caller
 *     ueberschreibt nicht.
 */

export interface EmailMessage {
  /** Empfänger — single recipient pro Call. Multi-To gibt's nicht. */
  readonly to: string;
  /** Header-Subject. Wird gelogged (keine PII außer Recipient). */
  readonly subject: string;
  /** HTML-Body. Adapter darf escapen, nicht muss. */
  readonly html: string;
  /** Plain-Text-Fallback. Wird mitgesendet damit Spam-Score sinkt. */
  readonly text: string;
  /** Optionaler `Reply-To` Header (z.B. operator-Email). */
  readonly replyTo?: string;
}

export interface SendResult {
  /** Provider-eigene Message-ID (für Bounce-Tracking). */
  readonly id: string;
  /** Provider-Name fuer Audit-Trail (`resend`, `console`, ...). */
  readonly provider: string;
}

/**
 * Wird vom Adapter geworfen wenn der Send fehlschlägt. Caller (Route-
 * Handler) sollte das fail-soft behandeln: Audit-Event "email.send_failed"
 * + Fallback (z.B. UI zeigt Admin den ungesendeten Link zum manuellen
 * Versand).
 */
export class EmailSendError extends Error {
  public readonly provider: string;
  public readonly status: number | null;
  public readonly providerDetail: string;
  constructor(provider: string, status: number | null, detail: string) {
    super(`email send failed (${provider}, status=${status ?? 'n/a'}): ${detail}`);
    this.name = 'EmailSendError';
    this.provider = provider;
    this.status = status;
    this.providerDetail = detail;
  }
}

export interface EmailAdapter {
  readonly providerName: string;
  send(msg: EmailMessage): Promise<SendResult>;
}
