/**
 * Invite-Email-Template — Multi-User Tier 1 (2026-05-17).
 *
 * Bewusst minimal: subject + html + text. Keine HTML-Templating-Library —
 * wir machen string-interpolation + escape-helper. HTML-Style ist inline
 * weil 99% der Email-Clients <style> killen.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface InviteEmailArgs {
  readonly acceptUrl: string;
  readonly expiresAt: number;
  readonly invitedBy: string;
  readonly origin: string;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export function renderInviteEmail(args: InviteEmailArgs): RenderedEmail {
  const expiresAtUtc = new Date(args.expiresAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const safeAcceptUrl = escapeHtml(args.acceptUrl);
  const safeInviter = escapeHtml(args.invitedBy);
  const safeOrigin = escapeHtml(args.origin);

  const subject = `Einladung zu mcp-approval (von ${args.invitedBy})`;

  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:1.5rem;color:#1c1c1c">
<h2 style="margin-top:0">Du wurdest zu mcp-approval eingeladen</h2>
<p>${safeInviter} hat dich auf <a href="${safeOrigin}">${safeOrigin}</a> eingeladen.</p>
<p>Klick auf den Link unten, um den Account zu erstellen. Du wirst dann zu Google weitergeleitet, um dich anzumelden:</p>
<p style="margin:1.5rem 0">
  <a href="${safeAcceptUrl}" style="display:inline-block;padding:0.75rem 1.5rem;background:#1f7a3a;color:white;text-decoration:none;border-radius:6px">Einladung annehmen</a>
</p>
<p style="font-size:0.85rem;color:#555">Oder kopiere diesen Link manuell:<br/><code style="word-break:break-all">${safeAcceptUrl}</code></p>
<p style="font-size:0.85rem;color:#555">Der Link ist gueltig bis ${escapeHtml(expiresAtUtc)}. Falls du diese Einladung nicht erwartet hast, ignoriere die Email.</p>
</body></html>`;

  const text = `Du wurdest zu mcp-approval eingeladen.

${args.invitedBy} hat dich auf ${args.origin} eingeladen.

Klick auf diesen Link um den Account zu erstellen — du wirst zu Google weitergeleitet zum Anmelden:

${args.acceptUrl}

Der Link ist gueltig bis ${expiresAtUtc}.
Falls du diese Einladung nicht erwartet hast, ignoriere die Email.`;

  return { subject, html, text };
}
