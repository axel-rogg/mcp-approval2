/**
 * VertexAiAdapter — Stub.
 *
 * Wird in Burst 2 voll implementiert. Phase-0-Scope: Konstruktor + Stub-
 * Methoden mit detailliertem TODO fuer naechste Phase.
 *
 * Plan-Reference: docs/plans/active/PLAN-architecture-v1.md §8.
 *
 * Default-Models:
 *   - Embeddings: `text-embedding-005` (768-dim, Vertex EU-availability
 *                 europe-west4 / europe-west3)
 *   - Chat:       `gemini-2.0-flash-exp` (Stand 2026-05; spaeter
 *                 `gemini-3-flash` sobald GA)
 *
 * Auth (Burst 2):
 *   1. Self-Host: Service-Account-JSON-Key. GoogleAuth({ scopes:
 *      ['https://www.googleapis.com/auth/cloud-platform'] }).
 *      Service-Account-Key wird ALS CREDENTIAL gespeichert (Vault-encrypted,
 *      Bootstrap-Sonderfall — siehe PLAN §8.1).
 *   2. GCP-Native: Workload-Identity-Federation, kein JSON-Key.
 *
 * Endpoint-Pattern:
 *   - Embed:  POST https://<region>-aiplatform.googleapis.com/v1/projects/
 *             <project>/locations/<region>/publishers/google/models/
 *             text-embedding-005:predict
 *             body: { instances: [{content: text, task_type: 'RETRIEVAL_DOCUMENT'}] }
 *   - Chat:   POST .../publishers/google/models/<model>:streamGenerateContent
 *             body: { contents: [{role, parts: [{text}]}], generationConfig: {...} }
 *
 * Cost-Control (Burst 2):
 *   - Pre-Call: tokenize geschaetzt, multipliziere mit Price-Table,
 *     vergleiche mit `args.budgetUsd`. Refuse wenn exceeded.
 *   - Post-Call: echte usage in audit_log + per-User-Day-Counter.
 */

import { GoogleAuth } from 'google-auth-library';

import type {
  AiAdapter,
  ChatArgs,
  ChatResponse,
  EmbedArgs,
} from './interface.js';

const NOT_IMPL_MSG =
  'VertexAiAdapter: not implemented in Phase 0. ' +
  'Wird in Burst 2 vollstaendig gemaess PLAN-architecture-v1 §8.';

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
}

export class VertexAiAdapter implements AiAdapter {
  public readonly projectId: string;
  public readonly region: string;
  public readonly defaultEmbedModel: string;
  public readonly defaultChatModel: string;
  private readonly auth: VertexAiAuth;
  private readonly googleAuth: GoogleAuth | null;

  public constructor(opts: VertexAiAdapterOptions) {
    this.projectId = opts.projectId;
    this.region = opts.region ?? 'europe-west4';
    this.auth = opts.auth;
    this.defaultEmbedModel = opts.defaultEmbedModel ?? 'text-embedding-005';
    this.defaultChatModel = opts.defaultChatModel ?? 'gemini-2.0-flash-exp';
    // Konstruktor-Wiring nur, Aufruf passiert in Burst 2:
    if (opts.auth.mode === 'service-account-json') {
      // GoogleAuth.credentials expects a JWTInput-shaped object. We parse
      // the JSON and pass it through; runtime validation happens in
      // google-auth-library when getAccessToken is first called.
      const credentials = JSON.parse(opts.auth.keyJson) as {
        readonly client_email?: string;
        readonly private_key?: string;
        readonly type?: string;
      };
      this.googleAuth = new GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
    } else {
      // Workload-Identity: GoogleAuth picks up ADC from environment.
      this.googleAuth = new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
    }
    void this.auth;
    void this.googleAuth;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async embed(_args: EmbedArgs): Promise<Float32Array[]> {
    // TODO Burst 2:
    //   1. token = await this.googleAuth.getAccessToken()
    //   2. POST `https://${region}-aiplatform.googleapis.com/v1/projects/
    //      ${projectId}/locations/${region}/publishers/google/models/
    //      ${model || defaultEmbedModel}:predict`
    //      body: { instances: args.texts.map(t => ({ content: t,
    //                task_type: 'RETRIEVAL_DOCUMENT' })) }
    //   3. Response: { predictions: [{ embeddings: { values: number[] } }] }
    //   4. Map values -> Float32Array, return.
    //   5. Audit-log: model, input-token-count, latency.
    return Promise.reject(new Error(NOT_IMPL_MSG));
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async chat(_args: ChatArgs): Promise<ChatResponse> {
    // TODO Burst 2:
    //   1. Pre-Call: tokenize-estimate vs budgetUsd -> Refusal wenn exceeded.
    //   2. token = await this.googleAuth.getAccessToken()
    //   3. POST .../models/${model || defaultChatModel}:generateContent
    //      body: {
    //        contents: messages.map(m => ({
    //          role: m.role === 'assistant' ? 'model' : m.role,
    //          parts: [{ text: m.content }]
    //        })),
    //        generationConfig: { maxOutputTokens, temperature }
    //      }
    //   4. Response: { candidates: [{ content: { parts: [{ text }] },
    //                  finishReason }], usageMetadata: { promptTokenCount,
    //                  candidatesTokenCount } }
    //   5. Map finishReason ('STOP'->'stop', 'MAX_TOKENS'->'length', ...).
    //   6. Audit + per-user-day-budget update.
    return Promise.reject(new Error(NOT_IMPL_MSG));
  }
}
