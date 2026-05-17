/**
 * ResendEmailAdapter — production-Backend für transaktionale Emails.
 *
 * REST-API: POST https://api.resend.com/emails
 * Auth: `Authorization: Bearer <RESEND_API_KEY>`
 *
 * DNS-Voraussetzung: Domain in Resend-Dashboard hinzugefügt + DNS-Records
 * (DKIM `resend._domainkey` + DMARC + SPF) gesetzt. Bis Verify durch ist,
 * sendet Resend nur an die im Account hinterlegte Operator-Email (Test-Mode).
 *
 * Fail-Behavior: bei HTTP-Error wirft `EmailSendError`. Caller (Route)
 * sollte audit + fall back auf "PWA-UI zeigt Admin den Link manuell".
 */
import { EmailSendError } from './interface.js';
import type { EmailAdapter, EmailMessage, SendResult } from './interface.js';

export interface ResendEmailAdapterOptions {
  /** Resend API key (rs_...). */
  readonly apiKey: string;
  /** Default-from header (z.B. `mcp-approval2 <noreply@ai-toolhub.org>`). */
  readonly from: string;
  /** Override für Tests / staging — default `https://api.resend.com`. */
  readonly baseUrl?: string;
  /** Override für Tests — default global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Timeout in ms, default 10000. */
  readonly timeoutMs?: number;
}

interface ResendSuccessResponse {
  readonly id: string;
}

interface ResendErrorResponse {
  readonly name?: string;
  readonly message?: string;
  readonly statusCode?: number;
}

export class ResendEmailAdapter implements EmailAdapter {
  public readonly providerName = 'resend';
  private readonly apiKey: string;
  private readonly from: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: ResendEmailAdapterOptions) {
    if (!opts.apiKey) {
      throw new Error('ResendEmailAdapter: apiKey required');
    }
    if (!opts.from) {
      throw new Error('ResendEmailAdapter: from required');
    }
    this.apiKey = opts.apiKey;
    this.from = opts.from;
    this.baseUrl = opts.baseUrl ?? 'https://api.resend.com';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async send(msg: EmailMessage): Promise<SendResult> {
    const body = {
      from: this.from,
      to: [msg.to],
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/emails`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const detail = err instanceof Error ? err.message : String(err);
      throw new EmailSendError('resend', null, `network: ${detail}`);
    }
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text) as ResendErrorResponse;
        detail = parsed.message ?? parsed.name ?? detail;
      } catch {
        /* keep raw text */
      }
      throw new EmailSendError('resend', res.status, detail);
    }
    let parsed: ResendSuccessResponse;
    try {
      parsed = JSON.parse(text) as ResendSuccessResponse;
    } catch {
      throw new EmailSendError('resend', res.status, `non-JSON response: ${text.slice(0, 200)}`);
    }
    if (!parsed.id) {
      throw new EmailSendError('resend', res.status, 'response missing id');
    }
    return { id: parsed.id, provider: 'resend' };
  }
}
