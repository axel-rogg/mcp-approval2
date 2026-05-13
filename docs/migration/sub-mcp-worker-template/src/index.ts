/**
 * Sub-MCP-Worker — Hono-Server-Skeleton.
 *
 * Plan-Ref: docs/migration/sub-mcp-server-migration-guide.md §3.
 *
 * Endpoints:
 *   GET  /health           → 200 (auth-frei)
 *   POST /mcp              → MCP-Streamable-HTTP (tools/list + tools/call)
 *
 * Auth ist zweistufig — siehe auth.ts.
 *
 * Tools werden in `TOOL_REGISTRY` per Name registriert. Bei einer Adoption
 * eines neuen Sub-MCP-Workers fork-t man dieses File und tauscht die Imports
 * von `./tools/example-tool.js` durch die eigenen Tool-Module aus.
 */
import { Hono } from 'hono';
import { createAuthMiddleware, type SubMcpBindings } from './auth.js';
import { EXAMPLE_TOOLS, type ToolDef, type ToolResult } from './tools/example-tool.js';

const app = new Hono<SubMcpBindings>();

// ─── Tool-Registry ───────────────────────────────────────────────────────────
//
// Pro Tool ein Entry. Beim Adoption-Schritt 5 erweitern.
//
const TOOL_REGISTRY: ReadonlyMap<string, ToolDef> = new Map(
  EXAMPLE_TOOLS.map((t) => [t.name, t]),
);

// ─── Public ──────────────────────────────────────────────────────────────────

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: c.env.SUB_MCP_NAME ?? 'sub-mcp',
    now: Date.now(),
  }),
);

// ─── /mcp — protected by auth-middleware ─────────────────────────────────────

app.use('/mcp', createAuthMiddleware());

interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: {
    readonly name?: string;
    readonly arguments?: unknown;
  };
}

app.post('/mcp', async (c) => {
  let body: JsonRpcRequest;
  try {
    body = (await c.req.json()) as JsonRpcRequest;
  } catch {
    return c.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } },
      400,
    );
  }
  const rpcId = body.id ?? null;
  if (body.jsonrpc !== '2.0') {
    return c.json({
      jsonrpc: '2.0',
      id: rpcId,
      error: { code: -32600, message: 'jsonrpc must be "2.0"' },
    });
  }

  if (body.method === 'tools/list') {
    const tools = [...TOOL_REGISTRY.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return c.json({ jsonrpc: '2.0', id: rpcId, result: { tools } });
  }

  if (body.method === 'tools/call') {
    const name = body.params?.name;
    if (!name || typeof name !== 'string') {
      return c.json({
        jsonrpc: '2.0',
        id: rpcId,
        error: { code: -32602, message: 'params.name required' },
      });
    }
    const tool = TOOL_REGISTRY.get(name);
    if (!tool) {
      return c.json({
        jsonrpc: '2.0',
        id: rpcId,
        error: { code: -32601, message: `unknown tool '${name}'` },
      });
    }
    try {
      const result: ToolResult = await tool.run(c, body.params?.arguments ?? {});
      return c.json({ jsonrpc: '2.0', id: rpcId, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      return c.json({
        jsonrpc: '2.0',
        id: rpcId,
        error: { code: -32603, message: msg },
      });
    }
  }

  return c.json({
    jsonrpc: '2.0',
    id: rpcId,
    error: { code: -32601, message: `unsupported method '${body.method ?? ''}'` },
  });
});

export default app;
