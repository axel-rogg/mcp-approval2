/**
 * Display-Tool — `display`.
 *
 * Plan-Ref: docs/plans/done/PLAN-prefs.md (mcp-approval), portiert nach Burst 3.
 *
 * Read-only Helfer fuer den MCP-Client. Aggregiert das, was im UI fuer den
 * aktuellen User angezeigt werden sollte: User-Profil-Stamm (id, email,
 * displayName, role) plus ein Sections-Array, das die PWA in "Karten" rendern
 * kann (Approval-Detail-View Pattern aus mcp-approval/src/tools/display.ts).
 *
 * Wir liefern hier KEINE Approval-Daten — fuer Approval-Detail gibt's eigene
 * Routes; `display` ist der read-side "wer bin ich + was sieht der Client".
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';
import { getOwnProfile } from '../services/user.js';

export const DisplayInput = z.object({}).strict();
export type DisplayInputT = z.infer<typeof DisplayInput>;

export interface DisplaySection {
  readonly label: string;
  readonly body: string;
}

export interface DisplayResult {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly role: 'admin' | 'member';
  };
  readonly sections: ReadonlyArray<DisplaySection>;
  readonly serverTime: number;
}

/**
 * `section()` + `joinSections()` — re-export-fuer-Konsumenten Helfer aus
 * dem mcp-approval-Display-Modul (src/tools/display.ts). Pure functions, kein
 * State; ein WYSIWYS-Section-Builder, den andere Tools fuer ihr `display_text`-
 * Output benutzen koennen.
 */
export function section(label: string, body: string | null | undefined): string {
  if (body == null) return '';
  const trimmed = String(body).replace(/\s+$/, '');
  if (trimmed === '') return '';
  return `=== ${label} ===\n${trimmed}\n`;
}

export function joinSections(...sections: Array<string | null | undefined>): string {
  return sections
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join('\n')
    .replace(/\s+$/, '');
}

export function makeDisplayTool(): Tool<DisplayInputT, DisplayResult> {
  return {
    name: 'display',
    description:
      'Read-only: gibt Stammdaten + UI-Sektionen fuer den aktuellen User zurueck (fuer MCP-Client-Display).',
    sensitivity: 'read',
    inputSchema: DisplayInput,
    async execute(ctx: ToolContext): Promise<DisplayResult> {
      const profile = await getOwnProfile(ctx.db, ctx.userId);
      const sections: DisplaySection[] = [
        {
          label: 'Identity',
          body: `${profile.displayName} <${profile.email}>`,
        },
        {
          label: 'Role',
          body: profile.role,
        },
        {
          label: 'Status',
          body: profile.status,
        },
      ];
      return {
        user: {
          id: profile.id,
          email: profile.email,
          displayName: profile.displayName,
          role: profile.role,
        },
        sections,
        serverTime: Date.now(),
      };
    },
  };
}
