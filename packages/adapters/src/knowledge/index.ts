/**
 * Knowledge-Adapter — re-exports.
 *
 * Plan-Reference: docs/plans/active/PLAN-architecture-v1.md §2.1 + §7.
 * Wire-Reference: /workspaces/mcp-knowledge2/docs/CROSS-SERVICE-CONTRACT.md
 *                 + /workspaces/mcp-approval2/docs/CROSS-SERVICE-CONTRACT-RESOLUTION.md
 */

export type {
  CreateObjectArgs,
  Group,
  GroupMember,
  GroupShare,
  KnowledgeObject,
  ObjectsList,
  SearchHit,
  Share,
  ShareScope,
} from './types.js';

export type {
  AddGroupMemberArgs,
  ArchiveGroupArgs,
  CreateGroupArgs,
  CreateShareArgs,
  CreateShareWithGroupArgs,
  EraseUserArgs,
  EraseUserResult,
  GetGroupArgs,
  GetObjectArgs,
  KnowledgeAdapter,
  ListGroupsArgs,
  ListObjectsArgs,
  ListSharesArgs,
  OnBehalfOfFields,
  RemoveGroupMemberArgs,
  RevokeShareArgs,
  SearchArgs,
  SetGroupReadAuditArgs,
  SyncUserArgs,
  SyncUserResult,
  UpdateObjectArgs,
  UserSyncStatus,
} from './interface.js';

export {
  HttpKnowledgeAdapter,
} from './http-client.js';
export type {
  FetchLike,
  HttpKnowledgeAdapterOptions,
  JwtSigner,
  SignOboArgs,
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
