/**
 * Tool-Defaults-Tab — Legacy-Stub (Phase F, PLAN-tool-defaults-v2.md).
 *
 * Diese Datei rendert nicht mehr — sie redirected zur Server-Detail-View.
 * Der Top-Level-Router in main.ts catched `#/defaults` schon frueh
 * (window.location.replace → `#/tools/servers/native/defaults`). Dieser
 * Stub ist nur Sicherheitsnetz fuer den Fall dass der Router den Fall
 * nicht abdeckt (z.B. State-Race nach hash-Change).
 *
 * Die alte Implementation (~355 Zeilen UI gegen /v1/prefs) wurde entfernt
 * — `/v1/prefs` ist nie montiert worden, der alte Pfad war seit Mig 0024
 * tot. Phase B–E bauen den Defaults-Tab im Server-Detail-View.
 *
 * Vollstaendiges drop dieser Datei + `api-prefs.ts` + Router-Eintrag
 * `defaults` folgt nach >=30 Tagen (Mig 0030.deferred → drop user_tool_prefs).
 */
import type { ApiClient, Session } from './api.js';
import type { ApiPrefsClient } from './api-prefs.js';

export async function renderDefaultsTab(
  _root: HTMLElement,
  _api: ApiClient,
  _apiPrefs: ApiPrefsClient,
  _session: Session,
): Promise<void> {
  // Redirect zur neuen Surface. Verwendet replace damit die Browser-History
  // den toten Pfad nicht behaelt.
  window.location.replace('#/tools/servers/native/defaults');
}
