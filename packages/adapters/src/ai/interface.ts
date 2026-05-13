/**
 * AI-Adapter — Embeddings + Chat-Completion.
 *
 * Primary: Google Vertex AI (EU-Region) — siehe `./vertex.ts`.
 * Secondary in spaeteren Phasen: jeder beliebige OpenAI-API-kompatible
 * Endpoint (vLLM, OpenAI, Mistral).
 *
 * Plan-Reference: docs/plans/active/PLAN-architecture-v1.md §8.
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
  /** Fuer `tool`-role: Tool-Call-ID die der Assistant erzeugt hat. */
  readonly toolCallId?: string;
  /** Fuer `tool`-role: Name des aufgerufenen Tools. */
  readonly name?: string;
}

export interface EmbedArgs {
  /** z.B. 'text-embedding-005' (Vertex). Default haengt von Adapter ab. */
  readonly model?: string;
  readonly texts: ReadonlyArray<string>;
}

export interface ChatArgs {
  /** z.B. 'gemini-2.0-flash-exp' / 'gemini-3-flash'. */
  readonly model?: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly maxTokens?: number;
  /** 0.0 - 2.0. Default 0.7. */
  readonly temperature?: number;
  /** Cost-Control: per-Request-Budget in USD. Adapter wirft wenn exceeded. */
  readonly budgetUsd?: number;
}

export interface ChatUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** USD geschaetzt anhand Model-Preisliste; undefined wenn unbekannt. */
  readonly estimatedCostUsd?: number;
}

export interface ChatResponse {
  readonly content: string;
  readonly model: string;
  readonly finishReason: 'stop' | 'length' | 'tool_call' | 'content_filter' | 'other';
  readonly usage: ChatUsage;
}

export interface AiAdapter {
  /**
   * Embeddings fuer mehrere Texte. Returnt eine Float32Array pro Input.
   * Dimension haengt vom Modell ab (Vertex text-embedding-005: 768).
   */
  embed(args: EmbedArgs): Promise<Float32Array[]>;

  /**
   * One-Shot-Chat. Streaming wird in Phase 4 als separate Methode
   * `chatStream` ergaenzt.
   */
  chat(args: ChatArgs): Promise<ChatResponse>;
}
