/**
 * Knowledge-Adapter — re-exports.
 *
 * Plan-Reference: docs/plans/active/PLAN-architecture-v1.md §2.1 + §7.
 */

export type {
  CreateObjectArgs,
  KnowledgeObject,
  ObjectKind,
  ObjectsList,
  SearchHit,
  Share,
  ShareScope,
} from './types.js';

export type {
  CreateShareArgs,
  EraseUserArgs,
  EraseUserResult,
  KnowledgeAdapter,
  ListObjectsArgs,
  ListSharesArgs,
  RevokeShareArgs,
  SearchArgs,
  UpdateObjectArgs,
} from './interface.js';

export {
  HttpKnowledgeAdapter,
} from './http-client.js';
export type {
  FetchLike,
  HttpKnowledgeAdapterOptions,
  JwtSigner,
} from './http-client.js';

export {
  AuthError,
  ConflictError,
  KnowledgeError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ServiceError,
  ValidationError,
  errorFromResponse,
} from './errors.js';
