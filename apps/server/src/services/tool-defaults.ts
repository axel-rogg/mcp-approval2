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
import type { ToolDefaultProfilesService } from './tool-default-profiles.js';
import { HttpError } from '../lib/errors.js';

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
  /** Aktives Profil (Phase C). 'default' wenn keines explizit aktiviert. */
  readonly profileName: string;
}

/**
 * Pro-Tool-Summary fuer `_meta.defaults_summary` in `tools/list` (Phase D).
 * Eine Map<toolName, {active_profile, fields_with_defaults[]}> pro User.
 *
 * `active_profile` ist der Profile-Name dessen Defaults gerade greifen
 * (Active-Profile-Resolution via ToolDefaultProfilesService.activeProfileNameFor).
 *
 * `fields_with_defaults` enthaelt nur Felder mit `orphan_since IS NULL` —
 * orphan-markierte Defaults werden vom Resolver eh skipped, damit Listing
 * sie auch nicht als "configured" zeigt.
 */
export interface ToolDefaultsSummary {
  readonly activeProfile: string;
  readonly fieldsWithDefaults: ReadonlyArray<string>;
}

export interface ToolDefaultsService {
  resolveForTool(args: ResolveForToolArgs): Promise<ResolveForToolResult>;
  /**
   * Phase D: Aggregat fuer `tools/list._meta.defaults_summary`.
   *
   * Macht EINE Aggregat-Query: alle `user_server_tool_defaults`-Rows des
   * Users JOIN `user_tool_default_profiles is_active=TRUE` → pro
   * (sub_mcp_name, tool_name) ein Eintrag mit dem active-profile-Namen +
   * array_agg(field_name).
   *
   * Caller cached das Result request-lokal (kein cross-request-Cache wegen
   * RLS-Sicherheit).
   *
   * Returnt Map<toolName, ToolDefaultsSummary>. Tools ohne Defaults sind
   * NICHT in der Map — Caller checkt `summary.has(name)` und liefert null
   * im _meta sonst.
   */
  summarizeForUser(userId: string): Promise<ReadonlyMap<string, ToolDefaultsSummary>>;
}

export interface ToolDefaultsServiceOpts {
  readonly db: DbAdapter;
  /** Optional Drift-Detection-Callback. Siehe SchemaFieldsCallback. */
  readonly schemaFields?: SchemaFieldsCallback;
  /**
   * Phase C: ToolDefaultProfilesService fuer Active-Profile-Lookup.
   * Wenn nicht gesetzt, faellt der Resolver auf `profile_name='default'`
   * zurueck (Phase-B-Behavior).
   */
  readonly profiles?: ToolDefaultProfilesService;
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

interface SummaryRow {
  readonly sub_mcp_name: string;
  readonly tool_name: string;
  readonly active_profile: string;
  readonly fields: ReadonlyArray<string> | null;
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
  const { db, schemaFields, profiles, now = () => Date.now() } = opts;

  async function loadDefaults(
    scoped: ScopedDb,
    userId: string,
    subMcpName: string,
    toolName: string,
    profileName: string,
  ): Promise<ReadonlyArray<DefaultRow>> {
    return await scoped.query<DefaultRow>(
      `SELECT tool_name, field_name, profile_name,
              value_text, value_json, value_kind, orphan_since
         FROM user_server_tool_defaults
        WHERE user_id = $1
          AND sub_mcp_name = $2
          AND tool_name = $3
          AND profile_name = $4`,
      [userId, subMcpName, toolName, profileName],
    );
  }

  async function markOrphan(
    scoped: ScopedDb,
    userId: string,
    subMcpName: string,
    toolName: string,
    fieldName: string,
    profileName: string,
    orphanSince: number | null,
  ): Promise<void> {
    await scoped.query(
      `UPDATE user_server_tool_defaults
          SET orphan_since = $1
        WHERE user_id = $2 AND sub_mcp_name = $3
          AND tool_name = $4 AND field_name = $5
          AND profile_name = $6`,
      [orphanSince, userId, subMcpName, toolName, fieldName, profileName],
    );
  }

  async function loadSummary(
    scoped: ScopedDb,
    userId: string,
  ): Promise<ReadonlyArray<SummaryRow>> {
    // Phase D Aggregat-Query: pro (sub_mcp_name, tool_name) der active-profile
    // Name + alle field_name die einen Default haben (orphan-Rows excluded).
    //
    // LEFT JOIN auf user_tool_default_profiles is_active=TRUE damit auch
    // Profile-lose Defaults ('default'-Fallback ohne profiles-Row, frische
    // User) sichtbar bleiben — wir geben dann 'default' als active zurueck.
    return await scoped.query<SummaryRow>(
      `SELECT d.sub_mcp_name AS sub_mcp_name,
              d.tool_name    AS tool_name,
              COALESCE(p.profile_name, 'default') AS active_profile,
              array_agg(d.field_name ORDER BY d.field_name) AS fields
         FROM user_server_tool_defaults d
         LEFT JOIN user_tool_default_profiles p
                ON p.user_id      = d.user_id
               AND p.sub_mcp_name = d.sub_mcp_name
               AND p.is_active    = TRUE
        WHERE d.user_id = $1
          AND d.orphan_since IS NULL
          AND d.profile_name = COALESCE(p.profile_name, 'default')
        GROUP BY d.sub_mcp_name, d.tool_name, p.profile_name`,
      [userId],
    );
  }

  return {
    async summarizeForUser(userId) {
      const out = new Map<string, ToolDefaultsSummary>();
      await db.transaction(userId, async (scoped) => {
        const rows = await loadSummary(scoped, userId);
        for (const row of rows) {
          out.set(row.tool_name, {
            activeProfile: row.active_profile,
            fieldsWithDefaults: Array.isArray(row.fields)
              ? row.fields.filter((f): f is string => typeof f === 'string')
              : [],
          });
        }
      });
      return out;
    },

    async resolveForTool(args) {
      const subMcpName = subMcpFromToolName(args.toolName, args.subMcpServerNames);
      const knownFields = schemaFields ? schemaFields(args.toolName) : null;

      // Phase C: __profile-Override extrahieren + aus den User-Args strippen
      // bevor das Tool dispatched wird. Wenn das Profil nicht existiert
      // (user hat sich vertippt), werfen wir 400 statt silent fallback —
      // sonst kriegt der Tool-Call mysteriös andere Defaults.
      const userArgsRaw = args.args;
      const profileOverride = extractProfileOverride(userArgsRaw);
      const userInput: Record<string, unknown> = { ...userArgsRaw };
      delete userInput[RESERVED_PROFILE_ARG];

      let profileName = 'default';
      if (profiles) {
        if (profileOverride !== null) {
          const exists = await profiles.exists(args.userId, subMcpName, profileOverride);
          if (!exists) {
            throw HttpError.badRequest(
              'invalid_request',
              `profile '${profileOverride}' does not exist for server '${subMcpName}'`,
            );
          }
          profileName = profileOverride;
        } else {
          profileName = await profiles.activeProfileNameFor(args.userId, subMcpName);
        }
      } else if (profileOverride !== null) {
        // Caller setzt __profile aber Service hat keinen ProfilesService.
        // Wir akzeptieren das (Tests / dev-Mode) — der Wert wird in
        // loadDefaults via SELECT-Filter genutzt.
        profileName = profileOverride;
      }

      // User-Input-Attribution. null-Values gelten als nicht gesetzt →
      // Default darf einspringen.
      const resolvedInput: Record<string, unknown> = { ...userInput };
      const defaultsApplied: AppliedDefaultRow[] = [];
      // __profile selbst ist 'user-input' damit Approval-Display den Override
      // sichtbar dokumentiert (WYSIWYS).
      if (profileOverride !== null) {
        defaultsApplied.push({
          field: RESERVED_PROFILE_ARG,
          from: 'user-input',
          profile: profileOverride,
        });
      }
      for (const [field, value] of Object.entries(userInput)) {
        if (value !== undefined && value !== null) {
          defaultsApplied.push({ field, from: 'user-input' });
        }
      }

      // Defaults laden + Args-WIN-Merge + Orphan-Lazy-Write.
      await db.transaction(args.userId, async (scoped) => {
        const rows = await loadDefaults(
          scoped,
          args.userId,
          subMcpName,
          args.toolName,
          profileName,
        );
        const ts = now();
        for (const row of rows) {
          // Drift-Detection (Plan §10 Entscheidung ⑤).
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
                  profileName,
                  ts,
                );
              }
              continue;
            }
            if (row.orphan_since !== null) {
              await markOrphan(
                scoped,
                args.userId,
                subMcpName,
                args.toolName,
                row.field_name,
                profileName,
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
              profile: profileName,
            });
          }
        }
      });

      return { resolvedInput, defaultsApplied, subMcpName, profileName };
    },
  };
}

/**
 * Liest `__profile` aus den User-Args. Akzeptiert nur String-Werte mit
 * passendem Slug-Pattern. Returnt `null` wenn nicht gesetzt oder ungueltig
 * (Caller faellt auf Active-Profile zurueck).
 *
 * Validation gegen Profile-Name-Pattern verhindert SQL-Pollution durch
 * unkontrollierte User-Args (auch wenn Drizzle parametrisiert — Defense-
 * in-Depth).
 */
function extractProfileOverride(args: Record<string, unknown>): string | null {
  const raw = args[RESERVED_PROFILE_ARG];
  if (typeof raw !== 'string') return null;
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(raw)) return null;
  return raw;
}
