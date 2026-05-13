/**
 * VertexAiAdapter — Live-Implementation.
 *
 * Plan-Reference: docs/plans/active/PLAN-architecture-v1.md §8.
 *
 * Burst 2 (2026-05-13): Stub aus Phase 0 ersetzt. Live-Calls gegen Vertex AI
 * REST-API:
 *   - Embed: POST `<region>-aiplatform.googleapis.com/.../models/<model>:predict`
 *   - Chat:  POST `<region>-aiplatform.googleapis.com/.../models/<model>:generateContent`
 *
 * Default-Models:
 *   - Embeddings: `text-embedding-005` (768-dim, Vertex EU-availability
 *                 europe-west4 / europe-west3)
 *   - Chat:       `gemini-2.0-flash-exp` (Stand 2026-05; spaeter
 *                 `gemini-3-flash` sobald GA)
 *
 * Auth:
 *   - VertexAuth-Klasse (./vertex-auth.ts) macht Service-Account-JSON →
 *     selbst-signiertes JWT → Google-OAuth-Token-Exchange. Token-Cache mit
 *     60s Refresh-Lead.
 *   - Alternative: Workload-Identity (GCP-Native) — DI-erweiterbar weil der
 *     Adapter nur einen `getAccessToken()`-Provider braucht.
 *
 * Cost-Control:
 *   - Pre-call Cost-Estimation steht in apps/server/src/services/cost-tracker.ts.
 *   - Estimated USD via Pricing-Table dort. Per-User-Quota im
 *     cost-gate-Middleware.
 *
 * Pricing-Hinweis: hardcoded USD-Tabelle in cost-tracker.ts. TODO Phase 6:
 * dynamic pricing from Vertex billing API, not hardcoded.
 */

import type {
  AiAdapter,
  ChatArgs,
  ChatMessage,
  ChatResponse,
  EmbedArgs,
} from './interface.js';
import { VertexAuth } from './vertex-auth.js';
import type {
  ServiceAccountJson,
  VertexChatContent,
  VertexFinishReason,
  VertexGenerateContentRequest,
  VertexGenerateContentResponse,
  VertexPredictRequest,
  VertexPredictResponse,
} from './vertex-types.js';
import { VertexAiError } from './vertex-types.js';

export { VertexAiError } from './vertex-types.js';
export type {
  ServiceAccountJson,
  VertexFinishReason,
  VertexGenerateContentResponse,
  VertexPredictResponse,
} from './vertex-types.js';
export { VertexAuth } from './vertex-auth.js';

/**
 * Auth-Mode-Discriminator. service-account-json laeuft offline-bootstrap
 * (DEK in Vault), workload-identity fuer GCP-Native-Deploy.
 */
export type VertexAiAuth =
  | { readonly mode: 'service-account-json'; readonly keyJson: string }
  | { readonly mode: 'workload-identity' };

export interface VertexAiAdapterOptions {
  readonly projectId: string;
  /** GCP-Region. EU-only fuer DSGVO. Default: 'europe-west4'. */
  readonly region?: string;
  readonly auth: VertexAiAuth;
  /** Default-Embedding-Model. */
  readonly defaultEmbedModel?: string;
  /** Default-Chat-Model. */
  readonly defaultChatModel?: string;
  /** Custom fetch (fuer Tests). */
  readonly fetchImpl?: typeof fetch;
  /**
   * Direkt-Injektion eines bestehenden VertexAuth-Objekts (z.B. Tests). Wenn
   * gesetzt, wird `auth` nur fuer das mode-Flag genutzt.
   */
  readonly authProvider?: { getAccessToken(): Promise<string> };
}

const DEFAULT_REGION = 'europe-west4';
const DEFAULT_EMBED_MODEL = 'text-embedding-005';
const DEFAULT_CHAT_MODEL = 'gemini-2.0-flash-exp';

export class VertexAiAdapter implements AiAdapter {
  public readonly projectId: string;
  public readonly region: string;
  public readonly defaultEmbedModel: string;
  public readonly defaultChatModel: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authProvider: { getAccessToken(): Promise<string> };

  public constructor(opts: VertexAiAdapterOptions) {
    this.projectId = opts.projectId;
    this.region = opts.region ?? DEFAULT_REGION;
    this.defaultEmbedModel = opts.defaultEmbedModel ?? DEFAULT_EMBED_MODEL;
    this.defaultChatModel = opts.defaultChatModel ?? DEFAULT_CHAT_MODEL;
    this.fetchImpl = opts.fetchImpl ?? fetch;

    if (opts.authProvider) {
      this.authProvider = opts.authProvider;
    } else if (opts.auth.mode === 'service-account-json') {
      const parsed = JSON.parse(opts.auth.keyJson) as ServiceAccountJson;
      if (!parsed.client_email || !parsed.private_key || !parsed.token_uri) {
        throw new Error('VertexAiAdapter: service-account JSON missing required fields');
      }
      const authOpts: ConstructorParameters<typeof VertexAuth>[0] = {
        serviceAccountJson: parsed,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      };
      this.authProvider = new VertexAuth(authOpts);
    } else {
      // workload-identity: ADC-Pfad ist in GCP-Native-Deploy implementiert.
      // Fuer den Adapter-Layer bleibt das ein Future-Hook — wir werfen, damit
      // der Pfad explizit aktiviert werden muss.
      throw new Error(
        'VertexAiAdapter: workload-identity auth requires an injected authProvider',
      );
    }
  }

  public async embed(args: EmbedArgs): Promise<Float32Array[]> {
    if (args.texts.length === 0) {
      return [];
    }
    const model = args.model ?? this.defaultEmbedModel;
    const url = this.publisherUrl(model, 'predict');
    const token = await this.authProvider.getAccessToken();

    const body: VertexPredictRequest = {
      instances: args.texts.map((content) => ({
        content,
        taskType: 'RETRIEVAL_DOCUMENT',
      })),
    };

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new VertexAiError(response.status, await response.text());
    }

    const data = (await response.json()) as VertexPredictResponse;
    if (!Array.isArray(data.predictions)) {
      throw new VertexAiError(500, 'malformed predictions response');
    }

    return data.predictions.map((p) => {
      if (!p.embeddings || !Array.isArray(p.embeddings.values)) {
        throw new VertexAiError(500, 'prediction missing embeddings.values');
      }
      return new Float32Array(p.embeddings.values);
    });
  }

  public async chat(args: ChatArgs): Promise<ChatResponse> {
    const model = args.model ?? this.defaultChatModel;
    const url = this.publisherUrl(model, 'generateContent');
    const token = await this.authProvider.getAccessToken();

    const { contents, systemInstruction } = splitSystemAndContents(args.messages);

    const generationConfig: {
      maxOutputTokens?: number;
      temperature?: number;
    } = {};
    if (args.maxTokens !== undefined) generationConfig.maxOutputTokens = args.maxTokens;
    if (args.temperature !== undefined) generationConfig.temperature = args.temperature;

    const body: VertexGenerateContentRequest = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    };

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new VertexAiError(response.status, await response.text());
    }

    const data = (await response.json()) as VertexGenerateContentResponse;
    const candidate = data.candidates?.[0];
    if (!candidate) {
      throw new VertexAiError(500, 'no candidates in chat response');
    }

    const text =
      candidate.content?.parts.map((p) => p.text).join('') ?? '';
    const finishReason = mapFinishReason(candidate.finishReason);
    const usage = data.usageMetadata ?? {};

    return {
      content: text,
      model,
      finishReason,
      usage: {
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
      },
    };
  }

  private publisherUrl(model: string, action: 'predict' | 'generateContent'): string {
    return (
      `https://${this.region}-aiplatform.googleapis.com/v1/projects/${this.projectId}/` +
      `locations/${this.region}/publishers/google/models/${model}:${action}`
    );
  }
}

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

/**
 * Mappt unsere ChatMessage[] auf das Gemini-Format:
 *   - `system` → systemInstruction (Vertex hat ein dediziertes Top-Level-Feld)
 *   - `user` → role=user, parts=[{text}]
 *   - `assistant` → role=model, parts=[{text}]
 *   - `tool` → derzeit nicht supported; wir mappen das auf role=user mit einem
 *     `[tool ${name}]:`-Prefix, damit das Model wenigstens den Kontext sieht.
 *     Echtes function-calling kommt in Phase 4.
 *
 * Sequenz-Constraint: Vertex erwartet alternierende user/model rollen.
 * Aufeinanderfolgende same-role-messages werden zu einer zusammengezogen.
 */
function splitSystemAndContents(
  messages: ReadonlyArray<ChatMessage>,
): {
  contents: VertexChatContent[];
  systemInstruction: VertexChatContent | undefined;
} {
  const systemTexts: string[] = [];
  const raw: VertexChatContent[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      systemTexts.push(m.content);
      continue;
    }
    const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';
    let text = m.content;
    if (m.role === 'tool') {
      const label = m.name ? `tool ${m.name}` : 'tool';
      text = `[${label}] ${m.content}`;
    }
    raw.push({ role, parts: [{ text }] });
  }

  // Aufeinanderfolgende gleiche Rollen mergen.
  const merged: VertexChatContent[] = [];
  for (const c of raw) {
    const last = merged[merged.length - 1];
    if (last && last.role === c.role) {
      const mergedText = [...last.parts.map((p) => p.text), ...c.parts.map((p) => p.text)].join(
        '\n',
      );
      merged[merged.length - 1] = { role: last.role, parts: [{ text: mergedText }] };
    } else {
      merged.push(c);
    }
  }

  const systemInstruction =
    systemTexts.length > 0
      ? { role: 'user' as const, parts: [{ text: systemTexts.join('\n') }] }
      : undefined;

  return { contents: merged, systemInstruction };
}

function mapFinishReason(reason: VertexFinishReason | undefined): ChatResponse['finishReason'] {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter';
    case 'MALFORMED_FUNCTION_CALL':
      return 'tool_call';
    case 'RECITATION':
    case 'OTHER':
    case undefined:
    default:
      return 'other';
  }
}
