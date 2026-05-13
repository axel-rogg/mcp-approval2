/**
 * System-Tools — `system.health` und `system.echo`.
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Burst 3.
 *
 * Beides Read-Only Tools fuer Smoke-Testing der MCP-Pipeline. `system.health`
 * meldet einen statischen "ok"-Status (Hub-Lebenszeichen ueber MCP statt HTTP).
 * `system.echo` ist Test-Tool, identisch zum `echoTool` aus registry.ts, aber
 * unter dem `system.*`-Namespace registriert.
 */
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';
import type { ToolResultContent } from '../mcp/protocol/types.js';
import {
  SystemEchoInput,
  SystemHealthInput,
  type SystemEchoInput as SystemEchoInputT,
  type SystemHealthInput as SystemHealthInputT,
} from './types.js';

export interface SystemHealthResult {
  readonly status: 'ok';
  readonly timestamp: number;
  readonly userId: string;
  readonly requestId: string;
}

export function makeSystemHealthTool(): Tool<SystemHealthInputT, SystemHealthResult> {
  return {
    name: 'system.health',
    description: 'Hub-Lebenszeichen ueber MCP. Liefert {status, timestamp, userId, requestId}.',
    sensitivity: 'read',
    inputSchema: SystemHealthInput,
    async execute(ctx: ToolContext): Promise<SystemHealthResult> {
      return {
        status: 'ok',
        timestamp: Date.now(),
        userId: ctx.userId,
        requestId: ctx.requestId,
      };
    },
  };
}

export function makeSystemEchoTool(): Tool<SystemEchoInputT, ToolResultContent[]> {
  return {
    name: 'system.echo',
    description: 'Echoes the input message back. Read-only smoke-test tool.',
    sensitivity: 'read',
    inputSchema: SystemEchoInput,
    async execute(_ctx, input): Promise<ToolResultContent[]> {
      return [{ type: 'text', text: `echo: ${input.message}` }];
    },
  };
}
