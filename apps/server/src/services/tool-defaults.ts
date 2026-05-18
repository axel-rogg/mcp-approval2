/**
 * ToolDefaultsService — Hub-side `applyDefaults`-Layer fuer Tool-Calls.
 *
 * Plan-Ref: docs/plans/active/PLAN-tool-defaults-v2.md (Phase A).
 *
 * Verantwortung:
 *   - `resolveForTool({userId, toolName, args})` wird vom MCP-Transport vor
 *     `registry.dispatch` aufgerufen. Mergt gespeicherte Defaults aus
 *     `user_server_tool_defaults` in den Tool-Input (Args-WIN — explizit
 *     gesetzte Werte ueberschreiben Defaults). Liefert `defaultsApplied[]`
 *     fuer WYSIWYS-Display in der Approval-PWA.
 *   - Sub-MCP-Routing via `subMcpFromToolName(name)`:
 *       prefix in subMcpServerNames → prefix
 *       prefix === 'kc'             → 'knowledge2'
 *       sonst                       → 'native'
 *     Reservierungs-Liste (Entscheidung 2026-05-18) verhindert Konflikte mit
 *     nativen Tool-Namespaces (apps.*, docs.*, ...).
 *
 * Phase A bleibt minimal — nur `profile_name='default'` wird gelesen, keine
 * Multi-Profile-Resolution (kommt in Phase C).
 */
import type { DbAdapter, ScopedDb } from '@mcp-approval2/adapters';
import type { AppliedDefaultRow } from '../schema/postgres/approvals.js';

// ---------------------------------------------------------------------------
// Konstanten — Entscheidungen 2026-05-18 (siehe PLAN-tool-defaults-v2.md §10)
// ---------------------------------------------------------------------------

/**
 * Native Tool-Namespaces, die NICHT als Sub-MCP-Server-Namen vergeben werden
 * duerfen. `POST /v1/me/servers`-Validator + `registry.register`-Hook lehnen
 * Versuche ab, einen Sub-MCP-Server mit einem dieser Namen anzulegen.
 *
 * Plan-Ref: PLAN-tool-defaults-v2.md §10 Entscheidung ①.
 */
export const RESERVED_SUB_MCP_NAMES: ReadonlySet<string> = new Set([
  'apps',
  'docs',
  'skills',
  'kc',
  'tools',
  'prefs',
  'tool_defaults',
  'groups',
  'native',
  'memorize',
]);

/**
 * Per-Call-Override-Argument-Name. Wenn ein Tool-Call `arguments.__profile`
 * setzt, nutzt der Resolver dieses Profil statt des aktiven (Phase C). Der
 * Wert wird vor `registry.dispatch` aus den Args entfernt damit der Worker
 * keinen unbekannten Schlüssel sieht.
 *
 * Tools, die `__profile` als Property im inputSchema deklarieren, werden
 * vom Linter (`scripts/lint-tools.mjs`) und vom Registry-Register-Hook
 * abgelehnt (Plan-Entscheidung ①).
 */
export const RESERVED_PROFILE_ARG = '__profile';

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export interface ResolveForToolArgs {
  readonly userId: string;
  readonly toolName: string;
  /** Caller-supplied Args. Wird shallow-kopiert; nicht mutiert. */
  readonly args: Record<string, unknown>;
  /**
   * Optional Set der registrierten Sub-MCP-Server-Namen (z.B. `gws`, `cf`).
   * Wird fuer subMcpFromToolName() benoetigt. Wenn weggelassen, gelten nur
   * `kc` → 'knowledge2' und alles andere → 'native'.
   */
  readonly subMcpServerNames?: ReadonlySet<string>;
}

export interface ResolveForToolResult {
  /**
   * `args ∪ defaults` mit Args-WIN-Regel.
   * `__profile` ist hier bereits entfernt (Phase C).
   */
  readonly resolvedInput: Record<string, unknown>;
  /** Attribution-Liste fuer WYSIWYS, persistierbar in pending_approvals. */
  readonly defaultsApplied: AppliedDefaultRow[];
  /** Sub-MCP-Server, dem dieser Tool-Call zugeordnet wurde. */
  readonly subMcpName: string;
}

export interface ToolDefaultsService {
  resolveForTool(args: ResolveForToolArgs): Promise<ResolveForToolResult>;
}

export interface ToolDefaultsServiceOpts {
  readonly db: DbAdapter;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Heuristisches Mapping `tool.name → sub_mcp_name`.
 *
 * Konvention (Plan-Entscheidung ③):
 *   - kein '.' → 'native'
 *   - prefix in subMcpServerNames → prefix
 *   - prefix === 'kc' → 'knowledge2'
 *   - sonst → 'native'
 *
 * Reservierungs-Liste (RESERVED_SUB_MCP_NAMES) verhindert, dass ein Sub-MCP-
 * Server mit einem dieser Namen registriert wird → kein Konflikt mit Tools
 * wie `apps.invoke`, `docs.put`, etc.
 */
export function subMcpFromToolName(
  toolName: string,
  subMcpServerNames?: ReadonlySet<string>,
): string {
  const dotIdx = toolName.indexOf('.');
  if (dotIdx <= 0) return 'native';
  const prefix = toolName.slice(0, dotIdx);
  if (subMcpServerNames && subMcpServerNames.has(prefix)) return prefix;
  if (prefix === 'kc') return 'knowledge2';
  return 'native';
}

interface DefaultRow {
  readonly tool_name: string;
  readonly field_name: string;
  readonly value_text: string;
}

// ---------------------------------------------------------------------------
// Service-Factory
// ---------------------------------------------------------------------------

export function createToolDefaultsService(
  opts: ToolDefaultsServiceOpts,
): ToolDefaultsService {
  const { db } = opts;

  async function loadDefaults(
    scoped: ScopedDb,
    userId: string,
    subMcpName: string,
    toolName: string,
  ): Promise<ReadonlyArray<DefaultRow>> {
    // Phase A: nur profile_name='default' lesen. Phase C erweitert um
    // Per-Tool/Per-Server Active-Profile-Resolution.
    return await scoped.query<DefaultRow>(
      `SELECT tool_name, field_name, value_text
         FROM user_server_tool_defaults
        WHERE user_id = $1 AND sub_mcp_name = $2 AND tool_name = $3`,
      [userId, subMcpName, toolName],
    );
  }

  return {
    async resolveForTool(args) {
      const subMcpName = subMcpFromToolName(args.toolName, args.subMcpServerNames);

      // User-Input first abbilden (Attribution: 'user-input' pro nicht-
      // undefined-Field). null-Values gelten als nicht gesetzt → Default
      // darf einspringen (gleiche Convention wie v1 PrefsService).
      const userInput = args.args;
      const resolvedInput: Record<string, unknown> = { ...userInput };
      const defaultsApplied: AppliedDefaultRow[] = [];
      for (const [field, value] of Object.entries(userInput)) {
        if (value !== undefined && value !== null) {
          defaultsApplied.push({ field, from: 'user-input' });
        }
      }

      // Defaults laden + Args-WIN-Merge.
      const rows = await db.transaction(args.userId, (scoped) =>
        loadDefaults(scoped, args.userId, subMcpName, args.toolName),
      );
      for (const row of rows) {
        const userVal = resolvedInput[row.field_name];
        if (userVal === undefined || userVal === null) {
          // Phase A: value_text TEXT (Plain-String). Phase B macht value_json typed.
          resolvedInput[row.field_name] = row.value_text;
          defaultsApplied.push({
            field: row.field_name,
            from: 'tool-default',
          });
        }
      }

      return { resolvedInput, defaultsApplied, subMcpName };
    },
  };
}
