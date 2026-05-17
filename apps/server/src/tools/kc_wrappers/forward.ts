/**
 * KC2-Tool-Forwarder — ruft KC2's `/mcp` mit `tools/call`-Methode.
 *
 * Plan-Ref: PLAN-as3-autonomous.md §1.4 + §1.2 (OBO-Auth-Pattern).
 *
 * Verantwortung:
 *   - Build POST /mcp body (JSON-RPC `tools/call`).
 *   - Headers: `Authorization: Bearer <SERVICE_TOKEN>` + `X-On-Behalf-Of: <OBO-JWT>`.
 *   - OBO-JWT wird ueber den injected `signer` erzeugt; der Caller
 *     (kc_wrappers/index.ts) bringt den fertigen Signer mit.
 *   - Response unpacking: JSON-RPC `result` ist der ToolsCallResult
 *     (`{content, structuredContent?}`).
 *   - Fehler-Mapping: JSON-RPC error → Error mit `code` + `message`.
 */
import type { JwtSigner } from '@mcp-approval2/adapters';
import type {
  ToolsCallResult,
  ToolResultContent,
} from '../../mcp/protocol/types.js';

export interface KcForwardArgs {
  readonly knowledgeUrl: string;
  readonly serviceToken: string;
  readonly signer: JwtSigner;
  readonly fetchImpl?: typeof fetch;
  /** Tool-Name wie er KC2-side heisst (1:1 vom Manifest). */
  readonly toolName: string;
  readonly arguments: Record<string, unknown> | undefined;
  /** sub-Claim im OBO-JWT (= approval2-internal users.id). */
  readonly userId: string;
  /** on_behalf_of-Claim — Google-email. */
  readonly userEmail: string;
  /** approval_id-Claim bei write-Tools nach Approve. */
  readonly approvalId?: string;
  /** request_id-Claim fuer Cross-Service-Audit. */
  readonly requestId: string;
  /** Default 30000ms. */
  readonly timeoutMs?: number;
}

export interface KcForwardResult {
  readonly content: ToolResultContent[];
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}

/**
 * Fuehrt einen `tools/call`-Round-Trip gegen KC2 aus. Wirft bei Network,
 * JSON-RPC-Error, oder Schema-Mismatches — der Caller mappt das in eine
 * Tool-Result-Antwort fuer den MCP-Client.
 */
export async function forwardToKc(args: KcForwardArgs): Promise<KcForwardResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? 30000;
  const url = `${args.knowledgeUrl.replace(/\/+$/, '')}/mcp`;

  const oboArgs: {
    sub: string;
    aud: string;
    on_behalf_of: string;
    ttlSec: number;
    request_id?: string;
    approval_id?: string;
  } = {
    sub: args.userId,
    aud: 'mcp-knowledge2',
    on_behalf_of: args.userEmail,
    ttlSec: 120,
    request_id: args.requestId,
  };
  if (args.approvalId !== undefined) oboArgs.approval_id = args.approvalId;
  const oboToken = await args.signer.signOBO(oboArgs);

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: args.requestId,
    method: 'tools/call',
    params: {
      name: args.toolName,
      arguments: args.arguments ?? {},
    },
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${args.serviceToken}`,
        'x-on-behalf-of': oboToken,
        'x-request-id': args.requestId,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`KC2 tools/call HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`KC2 tools/call invalid JSON: ${(err as Error).message}`);
  }
  if (!isObjectRecord(parsed)) {
    throw new Error(`KC2 tools/call malformed response`);
  }
  if ('error' in parsed && parsed['error']) {
    const e = parsed['error'] as { code?: number; message?: string };
    throw new Error(`KC2 tools/call error: ${e.message ?? 'unknown'} (code=${e.code ?? '?'})`);
  }
  const result = parsed['result'];
  if (!isObjectRecord(result)) {
    throw new Error(`KC2 tools/call missing result`);
  }
  // Wire-shape: ToolsCallResult = {content: [...], isError?, structuredContent?}.
  const content = Array.isArray(result['content'])
    ? (result['content'] as ToolResultContent[])
    : [];
  const out: KcForwardResult = { content };
  if (result['isError'] === true) {
    (out as { isError?: boolean }).isError = true;
  }
  if (isObjectRecord(result['structuredContent'])) {
    (out as { structuredContent?: Record<string, unknown> }).structuredContent =
      result['structuredContent'];
  }
  return out;
}

function isObjectRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Re-export for ToolsCallResult-Compatibility-Surface.
export type { ToolsCallResult };
