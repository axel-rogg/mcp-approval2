/**
 * Block-Library — TypeScript-Interfaces fuer das Composable-Apps-Layer.
 *
 * Plan-Ref: mcp-approval/docs/plans/PLAN-apps-blocks.md (portiert).
 * Spec-Ref: docs/reviews/A2UI-v0.10-spec-readout.md.
 *
 * Ein Block ist eine wiederverwendbare UI-Komponente mit:
 *  - state-Schema (was im DataModel steht)
 *  - actions (Mutationen, jeweils mit sensitivity + approval-display-template)
 *  - queries (computed-properties via named-method-dispatch — KEIN Eval)
 *  - a2ui-Component-Mapping (welche A2UI-Komponente rendert das)
 *
 * Sensitivity-Modell ist hier block-lokal ('read' | 'approval'):
 *   - 'read': iframe-side direct-execute, MCP-Path auch direct
 *   - 'approval': WebAuthn-Approval-Roundtrip (siehe iframe_auto_approve)
 * Der globale Tool-Layer in `../tools/apps-tools.ts` mapped das auf
 * `ToolSensitivity` ('read' | 'write' | 'danger').
 */

export type BlockSensitivity = 'read' | 'approval';

/**
 * Eine Action ist eine state-mutierende Operation auf einem Block.
 *
 * Approval-Round-Trip-Flow:
 *   1. iframe/MCP sendet Action mit payload
 *   2. Worker validiert payload
 *   3. Bei sensitivity='approval': pending-approval-Insert; bei 'read'
 *      direkt ausfuehren.
 *   4. Approval signiert → handler(state, payload) → {patches, result}
 *   5. Caller dispatcht updateDataModel + actionResponse an iframe
 */
export interface BlockActionDef<S = unknown, P = unknown> {
  readonly name: string;
  readonly description?: string;
  readonly payload_schema: Record<string, unknown>;
  readonly sensitivity: BlockSensitivity;
  /**
   * Mustache-Template fuer Approval-PWA-Display. Variablen:
   *  - payload.<field>
   *  - current_state.<field>
   *  - app_title
   */
  readonly approval_display_template?: string;
  /**
   * Wenn `true`: iframe-dispatch fuehrt das ohne WebAuthn-Approval aus
   * (JWT-Trust-Delegation). MCP-Path bleibt approval-pflichtig.
   */
  readonly iframe_auto_approve?: boolean;
  /**
   * Pure-Funktion: state + payload → patches + optional result.
   * patches[].path ist block-relativ (z.B. '/items').
   */
  readonly handler: (state: S, payload: P) => {
    readonly patches: ReadonlyArray<{ readonly path: string; readonly value: unknown }>;
    readonly result?: unknown;
  };
}

/**
 * Eine Query ist eine read-only computed property auf einem Block-State.
 */
export interface BlockQueryDef<S = unknown, A = unknown, R = unknown> {
  readonly name: string;
  readonly description?: string;
  readonly args_schema?: Record<string, unknown>;
  readonly returns_schema?: Record<string, unknown>;
  readonly compute: (state: S, args: A) => R;
}

/**
 * Eine Block-Definition. Pro Block-Type ein Eintrag, registriert beim
 * Worker-Boot via registerBlock() in catalog.ts.
 */
export interface BlockDef<S = unknown> {
  readonly type: string;
  readonly description?: string;
  readonly state_schema: Record<string, unknown>;
  readonly initial_state: () => S;
  readonly validate?: (state: S) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly actions: Record<string, BlockActionDef<S, any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly queries: Record<string, BlockQueryDef<S, any, any>>;
  readonly a2ui_component: string;
}

/**
 * Layout-Document — was als app-state in mcp-knowledge2 persistiert wird.
 *
 * components[] ist die Liste der instanziierten Bloecke in der App.
 * state ist der globale DataModel mit pro-Block-Slots unter ihrer block_id.
 */
export interface LayoutComponent {
  readonly id: string;
  readonly block: string;
  readonly config?: Record<string, unknown>;
}

export interface TemplateTab {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
}

export interface TemplateConfig {
  readonly kind: 'tabs' | 'single';
  readonly tabs?: ReadonlyArray<TemplateTab>;
  readonly background: 'mountain' | 'ocean' | 'abstract' | 'dance' | 'none';
  readonly theme: 'frosted-glass' | 'flat';
}

export interface LayoutDoc {
  readonly version: 'v0.10';
  readonly components: ReadonlyArray<LayoutComponent>;
  readonly state: Record<string, unknown>;
  readonly meta?: {
    readonly sendDataModel?: boolean;
    readonly template?: TemplateConfig;
  };
}
