/**
 * @mcp-approval2/adapters — portable runtime adapters.
 *
 * Plan-Reference: docs/plans/active/PLAN-architecture-v1.md §7 + §13.
 *
 * Layer:
 *   - DbAdapter        (Postgres primary, SQLite for tests)
 *   - BlobAdapter      (S3-API primary, LocalFS for dev)
 *   - KekProvider      (OpenBao for prod, Local for dev/tests)
 *   - AiAdapter        (Vertex AI; Stub in Phase 0)
 */

// DB
export type {
  DbAdapter,
  DbDialect,
  RawDb,
  ScopedDb,
  TransactionCtx,
} from './db/interface.js';
export { PostgresDbAdapter } from './db/postgres.js';
export type { PostgresDbAdapterOptions } from './db/postgres.js';
export { SqliteDbAdapter } from './db/sqlite.js';
export type { SqliteDbAdapterOptions } from './db/sqlite.js';

// Blob
export type {
  BlobAdapter,
  BlobMeta,
  GetResult,
  ListOptions,
  ListResult,
  PutOptions,
  PutResult,
} from './blob/interface.js';
export { S3BlobAdapter } from './blob/s3.js';
export type { S3BlobAdapterOptions } from './blob/s3.js';
export { LocalFsBlobAdapter } from './blob/local-fs.js';
export type { LocalFsBlobAdapterOptions } from './blob/local-fs.js';

// KEK
export type { KekProvider, KekRef } from './kek/interface.js';
export { LocalKekProvider } from './kek/local.js';
export type { LocalKekProviderOptions } from './kek/local.js';
export { OpenBaoKekProvider } from './kek/openbao.js';
export type { OpenBaoKekProviderOptions } from './kek/openbao.js';

// AI
export type {
  AiAdapter,
  ChatArgs,
  ChatMessage,
  ChatResponse,
  ChatRole,
  ChatUsage,
  EmbedArgs,
} from './ai/interface.js';
export { VertexAiAdapter, VertexAuth, VertexAiError } from './ai/vertex.js';
export type {
  ServiceAccountJson,
  VertexAiAdapterOptions,
  VertexAiAuth,
  VertexFinishReason,
  VertexGenerateContentResponse,
  VertexPredictResponse,
} from './ai/vertex.js';

// Knowledge (Storage-Service-Boundary)
export type {
  CreateObjectArgs,
  CreateShareArgs,
  EraseUserArgs,
  EraseUserResult,
  FetchLike,
  GetObjectArgs,
  HttpKnowledgeAdapterOptions,
  JwtSigner,
  KnowledgeAdapter,
  KnowledgeObject,
  ListObjectsArgs,
  ListSharesArgs,
  ObjectsList,
  OnBehalfOfFields,
  RevokeShareArgs,
  SearchArgs,
  SearchHit,
  Share,
  ShareScope,
  SignOboArgs,
  SyncUserArgs,
  SyncUserResult,
  UpdateObjectArgs,
  UserSyncStatus,
} from './knowledge/index.js';
export {
  AuthError as KnowledgeAuthError,
  ConflictError as KnowledgeConflictError,
  HttpKnowledgeAdapter,
  KnowledgeError,
  NotFoundError as KnowledgeNotFoundError,
  PermissionError as KnowledgePermissionError,
  RateLimitError as KnowledgeRateLimitError,
  ServiceError as KnowledgeServiceError,
  ValidationError as KnowledgeValidationError,
  errorFromResponse as knowledgeErrorFromResponse,
} from './knowledge/index.js';
