/**
 * Recovery-Email-Template — Multi-User Tier 1 (2026-05-17).
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RecoveryEmailArgs {
  readonly verifyUrl: string;
  readonly expiresAt: number;
  readonly origin: string;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export function renderRecoveryEmail(args: RecoveryEmailArgs): RenderedEmail {
  const expiresAtUtc = new Date(args.expiresAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const safeUrl = escapeHtml(args.verifyUrl);
  const safeOrigin = escapeHtml(args.origin);

  const subject = `Passkey-Recovery fuer mcp-approval`;

  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:1.5rem;color:#1c1c1c">
<h2 style="margin-top:0">Passkey-Recovery angefordert</h2>
<p>Es wurde ein Passkey-Recovery fuer deinen Account auf <a href="${safeOrigin}">${safeOrigin}</a> angefordert.</p>
<p>Wenn du das warst, klick auf den Link unten. Du wirst zu Google weitergeleitet zum Re-Auth, danach kannst du einen neuen Passkey enrollen. Alle alten Passkeys werden invalidated.</p>
<p style="margin:1.5rem 0">
  <a href="${safeUrl}" style="display:inline-block;padding:0.75rem 1.5rem;background:#1f7a3a;color:white;text-decoration:none;border-radius:6px">Recovery starten</a>
</p>
<p style="font-size:0.85rem;color:#555">Oder kopiere diesen Link manuell:<br/><code style="word-break:break-all">${safeUrl}</code></p>
<p style="background:#fff3cd;padding:0.75rem;border-radius:6px;font-size:0.9rem;margin-top:1rem">
<strong>Wenn du das NICHT warst:</strong> ignoriere diese Email. Dein Account bleibt unveraendert. Jemand hat moeglicherweise deine Email-Adresse geraten.
</p>
<p style="font-size:0.85rem;color:#555">Der Link ist gueltig bis ${escapeHtml(expiresAtUtc)}.</p>
</body></html>`;

  const text = `Passkey-Recovery angefordert.

Es wurde ein Passkey-Recovery fuer deinen Account auf ${args.origin} angefordert.

Wenn du das warst, klicke auf den Link unten — du wirst zu Google weitergeleitet zum Re-Auth, danach kannst du einen neuen Passkey enrollen.

${args.verifyUrl}

WICHTIG: Wenn du das NICHT warst, ignoriere die Email. Dein Account bleibt unveraendert.

Der Link ist gueltig bis ${expiresAtUtc}.`;

  return { subject, html, text };
}
