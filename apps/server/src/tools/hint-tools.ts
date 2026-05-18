/**
 * MCP-Tools fuer Tool-Default-Hints (Phase E, PLAN-tool-defaults-v2.md).
 *
 *   tool_defaults.hint.set    — write+Approval, upserten eines Hint-Texts
 *   tool_defaults.hint.remove — write+Approval, entfernen
 *
 * Hints sind kurze Frei-Text-Beschreibungen pro Field (≤500 chars), die der
 * Caller (LLM) als semantischen Hinweis nutzt. Lesepfad ist `tools.help`
 * (Phase D) + (in Phase E) auch der Elicitation-Hook im Transport.
 *
 * Sensitivity 'write' — User signt mit WebAuthn was er als Hint speichert.
 * WYSIWYS-Display zeigt den vollen Hint-Text + sub_mcp/tool/field.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';
import {
  subMcpFromToolName,
} from '../services/tool-defaults.js';
import type { ToolDefaultHintsService } from '../services/tool-default-hints.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TOOL_RE = /^[a-zA-Z_][a-zA-Z0-9_.:-]{0,127}$/;
const FIELD_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

export const HintSetInput = z
  .object({
    toolName: z.string().regex(TOOL_RE),
    fieldName: z.string().regex(FIELD_RE),
    hintText: z.string().max(500),
  })
  .strict();
export type HintSetInputT = z.infer<typeof HintSetInput>;

export const HintRemoveInput = z
  .object({
    toolName: z.string().regex(TOOL_RE),
    fieldName: z.string().regex(FIELD_RE),
  })
  .strict();
export type HintRemoveInputT = z.infer<typeof HintRemoveInput>;

export interface HintSetResult {
  readonly toolName: string;
  readonly fieldName: string;
  readonly subMcpName: string;
  readonly hintText: string;
  readonly updatedAt: number;
}

export interface HintRemoveResult {
  readonly toolName: string;
  readonly fieldName: string;
  readonly subMcpName: string;
  readonly removedAt: number;
}

export interface HintToolsDeps {
  readonly hints: ToolDefaultHintsService;
  /** Optional: Set bekannter Sub-MCP-Server-Namen fuer subMcpFromToolName. */
  readonly subMcpServerNames?: () => Promise<ReadonlySet<string>>;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function makeHintSetTool(deps: HintToolsDeps): Tool<HintSetInputT, HintSetResult> {
  return {
    name: 'tool_defaults.hint.set',
    description:
      'Set a hint (free text, ≤500 chars) for a tool field. Hints describe meaning ("0.0 deterministic .. 2.0 wild" for temperature) and are profile-overarching. Requires approval.',
    sensitivity: 'write',
    displayTemplate:
      'Set hint for {{toolName}}.{{fieldName}}: "{{hintText|preview:120}}"',
    inputSchema: HintSetInput,
    async execute(ctx: ToolContext, input: HintSetInputT): Promise<HintSetResult> {
      const subMcpSet = deps.subMcpServerNames ? await deps.subMcpServerNames() : undefined;
      const subMcpName = subMcpFromToolName(input.toolName, subMcpSet);
      const entry = await deps.hints.set({
        userId: ctx.userId,
        subMcpName,
        toolName: input.toolName,
        fieldName: input.fieldName,
        hintText: input.hintText,
      });
      return {
        toolName: entry.toolName,
        fieldName: entry.fieldName,
        subMcpName: entry.subMcpName,
        hintText: entry.hintText,
        updatedAt: entry.updatedAt,
      };
    },
  };
}

export function makeHintRemoveTool(
  deps: HintToolsDeps,
): Tool<HintRemoveInputT, HintRemoveResult> {
  return {
    name: 'tool_defaults.hint.remove',
    description:
      'Remove the hint for a tool field. No-op if no hint was stored. Requires approval.',
    sensitivity: 'write',
    displayTemplate: 'Remove hint for {{toolName}}.{{fieldName}}',
    inputSchema: HintRemoveInput,
    async execute(ctx: ToolContext, input: HintRemoveInputT): Promise<HintRemoveResult> {
      const subMcpSet = deps.subMcpServerNames ? await deps.subMcpServerNames() : undefined;
      const subMcpName = subMcpFromToolName(input.toolName, subMcpSet);
      await deps.hints.remove(ctx.userId, subMcpName, input.toolName, input.fieldName);
      return {
        toolName: input.toolName,
        fieldName: input.fieldName,
        subMcpName,
        removedAt: Date.now(),
      };
    },
  };
}
