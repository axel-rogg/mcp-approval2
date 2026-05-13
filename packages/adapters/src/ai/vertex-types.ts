/**
 * Vertex AI — Request/Response-Types.
 *
 * Plan-Ref: PLAN-architecture-v1.md §8 (AI-Provider Google Vertex AI).
 *
 * Diese Types beschreiben das Wire-Format der Vertex-AI-REST-API auf
 * Cloud-Aiplatform v1. Wir mappen sie in unseren Adapter (vertex.ts) auf das
 * Adapter-Interface `AiAdapter` aus `./interface.ts`.
 *
 * Quellen:
 *   - Embed `:predict` —
 *     https://cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-text-embeddings
 *   - Chat `:generateContent` (Gemini) —
 *     https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/gemini
 */

// ----------------------------------------------------------------------------
// Embed (Publisher-Model :predict)
// ----------------------------------------------------------------------------

/**
 * `taskType` aus dem Vertex-Embedding-API. Wir nutzen `RETRIEVAL_DOCUMENT` fuer
 * gespeicherten Content, `RETRIEVAL_QUERY` fuer User-Query-Embeddings. Andere
 * Modi sind moeglich, aber nicht im aktuellen Hot-Path.
 */
export type VertexTaskType =
  | 'RETRIEVAL_DOCUMENT'
  | 'RETRIEVAL_QUERY'
  | 'SEMANTIC_SIMILARITY'
  | 'CLASSIFICATION'
  | 'CLUSTERING'
  | 'QUESTION_ANSWERING'
  | 'FACT_VERIFICATION';

export interface VertexPredictInstance {
  readonly content: string;
  readonly taskType?: VertexTaskType;
  readonly title?: string;
}

export interface VertexPredictRequest {
  readonly instances: ReadonlyArray<VertexPredictInstance>;
  readonly parameters?: {
    readonly autoTruncate?: boolean;
    readonly outputDimensionality?: number;
  };
}

export interface VertexEmbeddingStatistics {
  readonly token_count: number;
  readonly truncated: boolean;
}

export interface VertexPredictPrediction {
  readonly embeddings: {
    readonly values: ReadonlyArray<number>;
    readonly statistics?: VertexEmbeddingStatistics;
  };
}

export interface VertexPredictResponse {
  readonly predictions: ReadonlyArray<VertexPredictPrediction>;
  readonly metadata?: {
    readonly billableCharacterCount?: number;
  };
}

// ----------------------------------------------------------------------------
// Chat (Gemini :generateContent)
// ----------------------------------------------------------------------------

export type VertexChatRole = 'user' | 'model';

export interface VertexChatPart {
  readonly text: string;
}

export interface VertexChatContent {
  readonly role: VertexChatRole;
  readonly parts: ReadonlyArray<VertexChatPart>;
}

export interface VertexGenerationConfig {
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly stopSequences?: ReadonlyArray<string>;
}

export interface VertexSafetySetting {
  readonly category: string;
  readonly threshold: string;
}

export interface VertexGenerateContentRequest {
  readonly contents: ReadonlyArray<VertexChatContent>;
  readonly systemInstruction?: VertexChatContent;
  readonly generationConfig?: VertexGenerationConfig;
  readonly safetySettings?: ReadonlyArray<VertexSafetySetting>;
}

/**
 * Vertex liefert mehrere Kandidaten — wir lesen nur candidates[0] aus. Wenn
 * Streaming-Support kommt, ist das pro-Chunk eines davon.
 */
export type VertexFinishReason =
  | 'STOP'
  | 'MAX_TOKENS'
  | 'SAFETY'
  | 'RECITATION'
  | 'OTHER'
  | 'BLOCKLIST'
  | 'PROHIBITED_CONTENT'
  | 'SPII'
  | 'MALFORMED_FUNCTION_CALL';

export interface VertexCandidate {
  readonly content?: VertexChatContent;
  readonly finishReason?: VertexFinishReason;
  readonly index?: number;
  readonly safetyRatings?: ReadonlyArray<unknown>;
}

export interface VertexUsageMetadata {
  readonly promptTokenCount?: number;
  readonly candidatesTokenCount?: number;
  readonly totalTokenCount?: number;
}

export interface VertexGenerateContentResponse {
  readonly candidates?: ReadonlyArray<VertexCandidate>;
  readonly usageMetadata?: VertexUsageMetadata;
  readonly modelVersion?: string;
}

// ----------------------------------------------------------------------------
// OAuth Token-Exchange
// ----------------------------------------------------------------------------

/**
 * Service-Account-Key-JSON-Form (minimaler Auszug). Wir akzeptieren nur die
 * Felder die wir wirklich brauchen — Vertex liefert noch `project_id` /
 * `auth_uri` / etc., die ignorieren wir bewusst.
 */
export interface ServiceAccountJson {
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri: string;
}

export interface VertexOauthTokenResponse {
  readonly access_token: string;
  readonly expires_in: number;
  readonly token_type: string;
}

// ----------------------------------------------------------------------------
// Errors
// ----------------------------------------------------------------------------

/**
 * Vertex-API-spezifischer Fehler. Carrying status + body damit Caller das
 * differenziert behandeln kann (z.B. 429 → Rate-Limit, 401 → Token-refresh).
 */
export class VertexAiError extends Error {
  public readonly status: number;
  public readonly bodyText: string;

  constructor(status: number, bodyText: string) {
    super(`Vertex AI request failed: ${status} ${bodyText.slice(0, 200)}`);
    this.name = 'VertexAiError';
    this.status = status;
    this.bodyText = bodyText;
  }
}
