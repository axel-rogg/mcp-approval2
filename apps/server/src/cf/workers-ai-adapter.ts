/**
 * CfWorkersAiAdapter — embeddings + chat via Cloudflare Workers AI.
 *
 * Implements `AiAdapter` from `@mcp-approval2/adapters` so app-factory code
 * (KnowledgeService, capability_search, etc.) stays adapter-agnostic.
 *
 * Defaults:
 *   - embed model:   @cf/baai/bge-base-en-v1.5  (768 dims, cosine — matches
 *                    the Vectorize index dim we ship in wrangler.jsonc)
 *   - chat model:    @cf/meta/llama-3.1-8b-instruct
 *
 * Fallback to Anthropic/OpenAI via AI Gateway:
 *   If `AI_GATEWAY_URL` is set (in vars), chat is proxied via Gateway. Gateway
 *   handles model routing, budget guards, and per-request caching. The same
 *   Workers AI binding still serves embeddings — Gateway-fallback is opt-in
 *   per call by passing a `model` arg of the form `gateway:<provider>:<model>`,
 *   which the adapter dispatches to fetch() instead of env.AI.run().
 *
 * Cost note: Workers AI is metered by neuron-second; on the free tier the
 * monthly budget is ~10k neurons, plenty for a single operator's chat usage.
 */
import type {
  Ai,
  AiTextGenerationOutput,
  AiTextEmbeddingsOutput,
} from '@cloudflare/workers-types';

import type {
  AiAdapter,
  ChatArgs,
  ChatResponse,
  EmbedArgs,
} from '@mcp-approval2/adapters';

const DEFAULT_EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const DEFAULT_CHAT_MODEL = '@cf/meta/llama-3.1-8b-instruct';

export interface CfWorkersAiAdapterOptions {
  readonly ai: Ai;
  /** Optional AI-Gateway endpoint (`https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/`) */
  readonly gatewayUrl?: string;
  /** Optional API token for AI-Gateway fallback (Anthropic/OpenAI auth). */
  readonly fallbackApiKey?: string;
  readonly defaultEmbedModel?: string;
  readonly defaultChatModel?: string;
}

export class CfWorkersAiAdapter implements AiAdapter {
  private readonly ai: Ai;
  private readonly gatewayUrl?: string;
  private readonly fallbackApiKey?: string;
  private readonly defaultEmbedModel: string;
  private readonly defaultChatModel: string;

  public constructor(opts: CfWorkersAiAdapterOptions) {
    this.ai = opts.ai;
    if (opts.gatewayUrl !== undefined) this.gatewayUrl = opts.gatewayUrl;
    if (opts.fallbackApiKey !== undefined) this.fallbackApiKey = opts.fallbackApiKey;
    this.defaultEmbedModel = opts.defaultEmbedModel ?? DEFAULT_EMBED_MODEL;
    this.defaultChatModel = opts.defaultChatModel ?? DEFAULT_CHAT_MODEL;
  }

  public async embed(args: EmbedArgs): Promise<Float32Array[]> {
    if (args.texts.length === 0) return [];
    const model = args.model ?? this.defaultEmbedModel;
    // Workers AI accepts a batch; up to 100 texts per call on bge-base.
    const res = (await this.ai.run(model, {
      text: args.texts as string[],
    })) as AiTextEmbeddingsOutput;
    if (!res.data || !Array.isArray(res.data)) {
      throw new Error(
        `CfWorkersAiAdapter.embed: unexpected response shape from ${model}`,
      );
    }
    return res.data.map((row) => Float32Array.from(row));
  }

  public async chat(args: ChatArgs): Promise<ChatResponse> {
    const model = args.model ?? this.defaultChatModel;
    if (model.startsWith('gateway:')) {
      return this.chatViaGateway(model, args);
    }
    const res = (await this.ai.run(model, {
      messages: args.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: args.maxTokens,
      temperature: args.temperature ?? 0.7,
    })) as AiTextGenerationOutput;
    const content =
      typeof res === 'object' && res !== null && 'response' in res
        ? String(res.response)
        : '';
    return {
      content,
      model,
      finishReason: 'stop',
      usage: {
        inputTokens: estimateTokens(args.messages.map((m) => m.content).join('\n')),
        outputTokens: estimateTokens(content),
      },
    };
  }

  /**
   * Format: `gateway:anthropic:claude-3-5-sonnet-latest` or
   *         `gateway:openai:gpt-4o-mini`.
   *
   * Requires `gatewayUrl` + `fallbackApiKey` to be configured at construction
   * time. We deliberately keep this minimal — operators who want more than a
   * one-shot completion via Gateway should reach for the dedicated SDK in a
   * separate Worker or pipe through queues.
   */
  private async chatViaGateway(spec: string, args: ChatArgs): Promise<ChatResponse> {
    if (!this.gatewayUrl) {
      throw new Error(
        'CfWorkersAiAdapter: gateway model requested but AI_GATEWAY_URL is not set.',
      );
    }
    if (!this.fallbackApiKey) {
      throw new Error(
        'CfWorkersAiAdapter: gateway model requested but no fallback API key configured.',
      );
    }
    const [, provider, model] = spec.split(':');
    if (!provider || !model) {
      throw new Error(
        `CfWorkersAiAdapter: invalid gateway model spec "${spec}". Expected gateway:<provider>:<model>.`,
      );
    }
    const url = `${this.gatewayUrl.replace(/\/$/, '')}/${provider}/v1/messages`;
    const body =
      provider === 'anthropic'
        ? {
            model,
            messages: args.messages
              .filter((m) => m.role !== 'system')
              .map((m) => ({ role: m.role, content: m.content })),
            system: args.messages.find((m) => m.role === 'system')?.content,
            max_tokens: args.maxTokens ?? 1024,
            temperature: args.temperature ?? 0.7,
          }
        : {
            model,
            messages: args.messages.map((m) => ({ role: m.role, content: m.content })),
            max_tokens: args.maxTokens ?? 1024,
            temperature: args.temperature ?? 0.7,
          };
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (provider === 'anthropic') {
      headers['x-api-key'] = this.fallbackApiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['authorization'] = `Bearer ${this.fallbackApiKey}`;
    }
    const r = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(
        `CfWorkersAiAdapter: gateway ${provider}/${model} returned ${r.status}: ${txt.slice(0, 200)}`,
      );
    }
    const json = (await r.json()) as unknown;
    const content = extractContent(json, provider);
    return {
      content,
      model: `gateway:${provider}:${model}`,
      finishReason: 'stop',
      usage: {
        inputTokens: estimateTokens(args.messages.map((m) => m.content).join('\n')),
        outputTokens: estimateTokens(content),
      },
    };
  }
}

function extractContent(json: unknown, provider: string): string {
  if (typeof json !== 'object' || json === null) return '';
  const obj = json as Record<string, unknown>;
  if (provider === 'anthropic' && Array.isArray(obj['content'])) {
    const parts = obj['content'] as Array<{ type?: string; text?: string }>;
    return parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('');
  }
  // OpenAI-compatible
  if (Array.isArray(obj['choices'])) {
    const choice = (obj['choices'] as Array<{ message?: { content?: string } }>)[0];
    return choice?.message?.content ?? '';
  }
  return '';
}

/**
 * Cheap token approximation — 4 chars per token. Real costs come from the
 * Cloudflare-side meter, this is only used to populate ChatResponse.usage for
 * downstream cost tracker bookkeeping that operates on rough estimates.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function createCfWorkersAiAdapter(
  opts: CfWorkersAiAdapterOptions,
): AiAdapter {
  return new CfWorkersAiAdapter(opts);
}
