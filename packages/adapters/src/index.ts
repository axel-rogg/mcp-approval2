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
export { VertexAiAdapter } from './ai/vertex.js';
export type {
  VertexAiAdapterOptions,
  VertexAiAuth,
} from './ai/vertex.js';
