/**
 * Tool-Input-Schemas (Zod).
 *
 * Plan-Ref: PLAN-architecture-v1.md §2 (Request-Lifecycle Step 4a),
 * §11 Burst 3 (Tool-Surface).
 *
 * Diese Schemas sind die Source-of-Truth fuer:
 *   - Runtime-Validation (Zod-parse in der Dispatcher-Pipeline)
 *   - JSON-Schema-Generation fuer MCP `tools/list`
 *
 * Wir halten die Schemas hier zentralisiert, damit:
 *   - Tests gegen dieselben Schemas validieren wie der Server
 *   - Type-Inference (`z.infer<typeof ...>`) im Tool-File konsistent ist
 */
import { z } from 'zod';

// =============================================================================
// User-Tools
// =============================================================================

export const UserProfileReadInput = z.object({}).strict();
export type UserProfileReadInput = z.infer<typeof UserProfileReadInput>;

export const UserProfileUpdateInput = z
  .object({
    displayName: z.string().min(1).max(120).optional(),
    email: z.string().email().max(254).optional(),
  })
  .strict()
  .refine(
    (v) => v.displayName !== undefined || v.email !== undefined,
    { message: 'at least one of displayName or email must be provided' },
  );
export type UserProfileUpdateInput = z.infer<typeof UserProfileUpdateInput>;

// =============================================================================
// Knowledge-Tools
// =============================================================================

const KnowledgeKind = z.enum(['doc', 'skill', 'app', 'memo']);

export const KnowledgeDocsCreateInput = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(1_000_000),
    description: z.string().max(2000).optional(),
    keywords: z.array(z.string().min(1).max(64)).max(32).optional(),
    subtype: z.string().min(1).max(64).optional(),
    visibility: z.enum(['private', 'shared']).optional(),
  })
  .strict();
export type KnowledgeDocsCreateInput = z.infer<typeof KnowledgeDocsCreateInput>;

export const KnowledgeDocsReadInput = z
  .object({
    id: z.string().min(1).max(128),
  })
  .strict();
export type KnowledgeDocsReadInput = z.infer<typeof KnowledgeDocsReadInput>;

export const KnowledgeDocsListInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    // D-4: cursor ist Integer (Unix-ms vom letzten updatedAt), nicht opaque string.
    cursor: z.number().int().nonnegative().optional(),
  })
  .strict();
export type KnowledgeDocsListInput = z.infer<typeof KnowledgeDocsListInput>;

export const KnowledgeSkillsListInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.number().int().nonnegative().optional(),
  })
  .strict();
export type KnowledgeSkillsListInput = z.infer<typeof KnowledgeSkillsListInput>;

export const KnowledgeSearchInput = z
  .object({
    query: z.string().min(1).max(1024),
    kinds: z.array(KnowledgeKind).max(4).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type KnowledgeSearchInput = z.infer<typeof KnowledgeSearchInput>;

// =============================================================================
// Credentials-Tools
// =============================================================================

const CredentialKind = z.enum([
  'oauth_refresh',
  'api_token',
  'password',
  'service_account',
]);

export const CredentialsListInput = z
  .object({
    provider: z.string().min(1).max(64).optional(),
  })
  .strict();
export type CredentialsListInput = z.infer<typeof CredentialsListInput>;

export const CredentialsAddInput = z
  .object({
    provider: z.string().min(1).max(64),
    kind: CredentialKind,
    label: z.string().min(1).max(120),
    secret: z.string().min(1).max(16_384),
    prfEnabled: z.boolean().optional(),
    /** Hex-encoded prfSessionId (resolved via PrfSessionService). */
    prfSessionId: z.string().min(1).max(256).optional(),
    expiresAt: z.number().int().nonnegative().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();
export type CredentialsAddInput = z.infer<typeof CredentialsAddInput>;

export const CredentialsDeleteInput = z
  .object({
    credentialId: z.string().min(1).max(128),
  })
  .strict();
export type CredentialsDeleteInput = z.infer<typeof CredentialsDeleteInput>;

// =============================================================================
// System-Tools
// =============================================================================

export const SystemHealthInput = z.object({}).strict();
export type SystemHealthInput = z.infer<typeof SystemHealthInput>;

export const SystemEchoInput = z
  .object({
    message: z.string().min(1).max(1024),
  })
  .strict();
export type SystemEchoInput = z.infer<typeof SystemEchoInput>;
