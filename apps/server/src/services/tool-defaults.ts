/**
 * ToolDefaultsService — Hub-side `applyDefaults`-Layer fuer Tool-Calls.
 *
 * Plan-Ref: docs/plans/active/PLAN-tool-defaults-v2.md (Phase A + B).
 *
 * Verantwortung:
 *   - `resolveForTool({userId, toolName, args})` wird vom MCP-Transport vor
 *     `registry.dispatch` aufgerufen. Mergt gespeicherte Defaults aus
 *     `user_server_tool_defaults` in den Tool-Input (Args-WIN — explizit
 *     gesetzte Werte ueberschreiben Defaults). Liefert `defaultsApplied[]`
 *     fuer WYSIWYS-Display in der Approval-PWA.
 *   - Phase B: typed `value_json` wird statt `value_text` gelesen. Drift-
 *     Detection via optional `schemaFields`-Callback: ein Default-Row dessen
 *     Field-Name nicht im Tool-Schema vorkommt wird lazy als `orphan_since`
 *     markiert und beim Merge uebersprungen (Plan §10 Entscheidung ⑤).
 *   - Sub-MCP-Routing via `subMcpFromToolName(name)`:
 *       prefix in subMcpServerNames → prefix
 *       prefix === 'kc'             → 'knowledge2'
 *       sonst                       → 'native'
 *     Reservierungs-Liste (Entscheidung 2026-05-18) verhindert Konflikte mit
 *     nativen Tool-Namespaces (apps.*, docs.*, ...).
 *
 * Phase A blieb auf `profile_name='default'` hardcoded; Phase B liest noch
 * weiterhin nur 'default' (Profile-Multi-Resolution kommt in Phase C).
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
 * keinen unbekannten Schluessel sieht.
 *
 * Tools, die `__profile` als Property im inputSchema deklarieren, werden
 * vom Linter und vom Registry-Register-Hook abgelehnt (Plan-Entscheidung ①).
 */
export const RESERVED_PROFILE_ARG = '__profile';

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/**
 * Optionaler Schema-Callback fuer Orphan-Detection.
 *
 * Plan §10 Entscheidung ⑤: wenn der Resolver beim Merge ein Default-Field
 * sieht, das nicht im Tool-Schema vorkommt, wird die DB-Row lazy als orphan
 * markiert und beim Merge uebersprungen (Worker bekommt keinen unknown-
 * property).
 *
 * Callback liefert die top-level property-Namen des Tool-`inputSchema`.
 * Returnt `null` wenn das Schema nicht analysierbar ist (z.B. `z.unknown()`
 * bei kc_wrappers) — Resolver skipt dann die Orphan-Detection und merged
 * naive (Pre-Phase-B Verhalten).
 */
export type SchemaFieldsCallback = (
  toolName: string,
) => ReadonlySet<string> | null;

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
   * `__profile` wird vor dem Dispatch entfernt (Phase C).
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
  /** Optional Drift-Detection-Callback. Siehe SchemaFieldsCallback. */
  readonly schemaFields?: SchemaFieldsCallback;
  /** Optional Clock fuer Tests. */
  readonly now?: () => number;
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
  readonly profile_name: string;
  readonly value_text: string;
  readonly value_json: unknown;
  readonly value_kind: string;
  readonly orphan_since: number | string | null;
}

/**
 * Bevorzugt `value_json` (typed, Phase B), faellt zurueck auf `value_text`
 * (legacy bei pre-0028-Rows).
 */
function effectiveValue(row: DefaultRow): unknown {
  if (row.value_json !== null && row.value_json !== undefined) {
    return row.value_json;
  }
  return row.value_text;
}

// ---------------------------------------------------------------------------
// Service-Factory
// ---------------------------------------------------------------------------

export function createToolDefaultsService(
  opts: ToolDefaultsServiceOpts,
): ToolDefaultsService {
  const { db, schemaFields, now = () => Date.now() } = opts;

  async function loadDefaults(
    scoped: ScopedDb,
    userId: string,
    subMcpName: string,
    toolName: string,
  ): Promise<ReadonlyArray<DefaultRow>> {
    // Phase B: liest aktiv-Profil falls vorhanden. Bis Phase C lebt
    // jeder User nur mit `profile_name='default'` (Mig 0028 seedet das fuer
    // alle existing Rows). Wir filtern also explizit:
    return await scoped.query<DefaultRow>(
      `SELECT tool_name, field_name, profile_name,
              value_text, value_json, value_kind, orphan_since
         FROM user_server_tool_defaults
        WHERE user_id = $1
          AND sub_mcp_name = $2
          AND tool_name = $3
          AND profile_name = 'default'`,
      [userId, subMcpName, toolName],
    );
  }

  async function markOrphan(
    scoped: ScopedDb,
    userId: string,
    subMcpName: string,
    toolName: string,
    fieldName: string,
    orphanSince: number | null,
  ): Promise<void> {
    await scoped.query(
      `UPDATE user_server_tool_defaults
          SET orphan_since = $1
        WHERE user_id = $2 AND sub_mcp_name = $3
          AND tool_name = $4 AND field_name = $5
          AND profile_name = 'default'`,
      [orphanSince, userId, subMcpName, toolName, fieldName],
    );
  }

  return {
    async resolveForTool(args) {
      const subMcpName = subMcpFromToolName(args.toolName, args.subMcpServerNames);
      const knownFields = schemaFields ? schemaFields(args.toolName) : null;

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

      // Defaults laden + Args-WIN-Merge + Orphan-Lazy-Write.
      await db.transaction(args.userId, async (scoped) => {
        const rows = await loadDefaults(scoped, args.userId, subMcpName, args.toolName);
        const ts = now();
        for (const row of rows) {
          // Drift-Detection (Plan §10 Entscheidung ⑤): wenn das Schema
          // bekannt ist und das Field fehlt → orphan markieren, skip merge.
          // Wenn das Schema das Field hat aber die Row orphan_since≠NULL
          // hatte → unset (Field ist zurueck).
          if (knownFields) {
            const fieldKnown = knownFields.has(row.field_name);
            if (!fieldKnown) {
              if (row.orphan_since === null) {
                await markOrphan(
                  scoped,
                  args.userId,
                  subMcpName,
                  args.toolName,
                  row.field_name,
                  ts,
                );
              }
              continue; // skip merge — Worker wuerde unknown-property werfen
            }
            if (row.orphan_since !== null) {
              await markOrphan(
                scoped,
                args.userId,
                subMcpName,
                args.toolName,
                row.field_name,
                null,
              );
            }
          }

          // Args-WIN: nur fuellen wenn User-Wert undefined oder null.
          const userVal = resolvedInput[row.field_name];
          if (userVal === undefined || userVal === null) {
            resolvedInput[row.field_name] = effectiveValue(row);
            defaultsApplied.push({
              field: row.field_name,
              from: 'tool-default',
            });
          }
        }
      });

      return { resolvedInput, defaultsApplied, subMcpName };
    },
  };
}
