/**
 * ConsoleEmailAdapter — Dev/Pilot-Bootstrap-Backend.
 *
 * Loggt die Email auf stdout (ohne body — body landet via Caller in der
 * `email_outbox`-Tabelle). Liefert eine pseudo-id zurück damit der
 * Caller-Code Provider-agnostic bleibt.
 *
 * Wird AKTIV verwendet wenn:
 *   - `EMAIL_PROVIDER` ist `console` (default) — z.B. wenn RESEND_API_KEY
 *     noch nicht gesetzt ist oder DNS-Verify pending.
 *   - Wenn Resend einen DNS/Auth-Fehler hat und der Caller einen
 *     manuellen Fallback ausloest (PWA-UI zeigt acceptUrl).
 *
 * Production: pruefen dass EMAIL_PROVIDER=resend gesetzt ist. Sonst
 * werden Invites nie wirklich abgeschickt — Operator MUSS dann
 * manuell aus PWA-UI / email_outbox-Tabelle senden.
 */
import type { EmailAdapter, EmailMessage, SendResult } from './interface.js';

export interface ConsoleEmailAdapterOptions {
  /** Override fuer Tests: Captures die Nachrichten in-memory. */
  readonly capture?: EmailMessage[];
  /** Override fuer Tests: silent-mode (kein console.log). */
  readonly silent?: boolean;
}

export class ConsoleEmailAdapter implements EmailAdapter {
  public readonly providerName = 'console';
  private readonly capture: EmailMessage[] | null;
  private readonly silent: boolean;
  private idCounter = 0;

  constructor(opts: ConsoleEmailAdapterOptions = {}) {
    this.capture = opts.capture ?? null;
    this.silent = opts.silent === true;
  }

  async send(msg: EmailMessage): Promise<SendResult> {
    if (this.capture) this.capture.push(msg);
    const id = `console-${Date.now()}-${this.idCounter++}`;
    if (!this.silent) {
      // eslint-disable-next-line no-console
      console.log(
        `[email/console] to=${msg.to} subject="${msg.subject}" id=${id} (body suppressed)`,
      );
    }
    return { id, provider: 'console' };
  }
}
