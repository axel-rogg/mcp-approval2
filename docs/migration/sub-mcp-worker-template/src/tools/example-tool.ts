/**
 * Beispiel-Tool fuer das Sub-MCP-Worker-Template.
 *
 * Zwei Demo-Implementations:
 *   1. `echo` — braucht KEIN Provider-Credential. Liest nur den User-Context
 *      und gibt eine annotierte Bestaetigung zurueck. Gut fuer Smoke-Tests.
 *   2. `whoami` — ruft optional `resolveCredential('google-workspace')` und
 *      fragt das Google-`userinfo`-Endpoint ab. Demonstriert den JIT-Pfad.
 *
 * Pattern: jede Tool-Funktion erhaelt `(c, args)` und liefert
 *   { content: [{type:'text', text:string}], isError: boolean }
 * — also direkt das MCP-`tools/call`-result-Format. Der Hono-Handler
 * in index.ts wickelt das nur noch in den jsonrpc-2.0-Envelope.
 */
import type { Context } from 'hono';
import { getUserContext, type SubMcpBindings } from '../auth.js';
import { resolveCredential, CredentialResolveError } from '../credentials.js';

export interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
  readonly isError?: boolean;
}

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly run: (c: Context<SubMcpBindings>, args: unknown) => Promise<ToolResult>;
}

export const echoTool: ToolDef = {
  name: 'example.echo',
  description: 'Echoes the given text back together with the resolved user_id. Useful as smoke-test.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', minLength: 1, maxLength: 4096 },
    },
    required: ['text'],
    additionalProperties: false,
  },
  async run(c, args) {
    const { userId } = getUserContext(c);
    const text =
      typeof (args as { text?: unknown }).text === 'string'
        ? ((args as { text: string }).text)
        : '<no-text>';
    return {
      content: [
        {
          type: 'text',
          text: `echo for user ${userId}: ${text}`,
        },
      ],
    };
  },
};

export const whoamiTool: ToolDef = {
  name: 'example.whoami',
  description:
    'Resolves the user\'s google-workspace credential JIT and calls Google userinfo. Demonstrates the credential-resolve flow.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async run(c) {
    const { userId } = getUserContext(c);
    try {
      const cred = await resolveCredential(c, {
        provider: 'google-workspace',
        label: 'default',
      });
      const resp = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${cred.accessToken}` },
      });
      if (!resp.ok) {
        return {
          content: [
            {
              type: 'text',
              text: `userinfo upstream ${resp.status}: ${await resp.text()}`,
            },
          ],
          isError: true,
        };
      }
      const data = (await resp.json()) as { email?: string; sub?: string };
      return {
        content: [
          {
            type: 'text',
            text: `user_id=${userId} google_email=${data.email ?? '<unknown>'} google_sub=${data.sub ?? '<unknown>'}`,
          },
        ],
      };
    } catch (err) {
      if (err instanceof CredentialResolveError) {
        // PRF-required ist KEIN technischer Fehler — der Caller soll das dem
        // User als "approve in PWA"-Hint anzeigen.
        const isPrf = err.code === 'prf_required';
        return {
          content: [
            {
              type: 'text',
              text: `credential resolve ${err.code} (status ${err.status}): ${err.message}`,
            },
          ],
          isError: !isPrf,
        };
      }
      const msg = err instanceof Error ? err.message : 'unknown error';
      return {
        content: [{ type: 'text', text: `internal error: ${msg}` }],
        isError: true,
      };
    }
  },
};

export const EXAMPLE_TOOLS: ReadonlyArray<ToolDef> = [echoTool, whoamiTool];
