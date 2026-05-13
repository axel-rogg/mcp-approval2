/**
 * Util-Tools — `util.now`, `util.uuid`.
 *
 * Plan-Ref: docs/plans/done/PLAN-prefs.md (mcp-approval) — Burst 3 Util-Helfer.
 *
 * Trivial-read-Tools, die Agents ohne Approval callen koennen. Zwei klassische
 * Use-Cases:
 *   - util.now  — Server-Zeit fuer Audit/Logging-Markers (Drift-Mass gegen
 *                 Client-Clock).
 *   - util.uuid — Random UUID-v4 fuer Caller-side Idempotency-Keys, ohne dass
 *                 der Agent eine eigene RNG mitbringen muss.
 */
import { z } from 'zod';
import { randomUuidV4 } from '@mcp-approval2/core';
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';

export const UtilNowInput = z.object({}).strict();
export type UtilNowInputT = z.infer<typeof UtilNowInput>;

export const UtilUuidInput = z
  .object({
    count: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type UtilUuidInputT = z.infer<typeof UtilUuidInput>;

export interface UtilNowResult {
  readonly unixMs: number;
  readonly iso: string;
  readonly timezone: string;
}

export interface UtilUuidResult {
  readonly uuids: ReadonlyArray<string>;
}

export function makeUtilNowTool(): Tool<UtilNowInputT, UtilNowResult> {
  return {
    name: 'util.now',
    description:
      'Read-only: Server-Zeit (Unix-ms, ISO-8601, UTC). Keine Args.',
    sensitivity: 'read',
    inputSchema: UtilNowInput,
    async execute(_ctx: ToolContext): Promise<UtilNowResult> {
      const ts = Date.now();
      return {
        unixMs: ts,
        iso: new Date(ts).toISOString(),
        timezone: 'UTC',
      };
    },
  };
}

export function makeUtilUuidTool(): Tool<UtilUuidInputT, UtilUuidResult> {
  return {
    name: 'util.uuid',
    description:
      'Read-only: random UUID-v4 (1-100 Stueck). Default 1.',
    sensitivity: 'read',
    inputSchema: UtilUuidInput,
    async execute(_ctx: ToolContext, input): Promise<UtilUuidResult> {
      const n = input.count ?? 1;
      const uuids: string[] = [];
      for (let i = 0; i < n; i++) uuids.push(randomUuidV4());
      return { uuids };
    },
  };
}
