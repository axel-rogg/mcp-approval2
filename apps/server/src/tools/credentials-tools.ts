/**
 * Credentials-Tools — List/Add/Delete fuer User-Service-Tokens.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5 (Credentials), §11 Burst 3.
 *
 * Tool-Inventar:
 *   - credentials.list   (read)              — ohne Secrets, nur Meta
 *   - credentials.add    (write, Approval)   — Secret + optional PRF
 *   - credentials.delete (danger, Approval)  — Hard-Delete
 *
 * PRF-Flow (§5.3):
 *   `credentials.add` mit `prfEnabled=true` benoetigt einen `prfSessionId`
 *   (vorher in der PWA gespeichert nach WebAuthn-PRF-Eval). Wir resolven die
 *   Session, holen den 32-Byte PRF-Output und reichen ihn an den Service
 *   weiter. Fehlt prfSessionId → `PrfRequiredError` (Caller mapped auf
 *   JSON-RPC-Error mit Code -32020 — die PWA triggert dann den PRF-Flow).
 */
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';
import { PrfRequiredError, type CredentialsService } from '../services/credentials.js';
import type { PrfSessionService } from '../services/prf-session.js';
import {
  CredentialsAddInput,
  CredentialsDeleteInput,
  CredentialsListInput,
  type CredentialsAddInput as CredentialsAddInputT,
  type CredentialsDeleteInput as CredentialsDeleteInputT,
  type CredentialsListInput as CredentialsListInputT,
} from './types.js';

export interface CredentialsToolsDeps {
  readonly credentials: CredentialsService;
  readonly prfSessions: PrfSessionService;
}

export interface CredentialMetaDto {
  readonly id: string;
  readonly provider: string;
  readonly kind: 'oauth_refresh' | 'api_token' | 'password' | 'service_account';
  readonly label: string;
  readonly prfEnabled: boolean;
  readonly createdAt: number;
  readonly rotatedAt: number | null;
  readonly lastUsedAt: number | null;
  readonly expiresAt: number | null;
}

// ---------------------------------------------------------------------------
// credentials.list
// ---------------------------------------------------------------------------

export function makeCredentialsListTool(
  deps: CredentialsToolsDeps,
): Tool<CredentialsListInputT, { items: ReadonlyArray<CredentialMetaDto> }> {
  return {
    name: 'credentials.list',
    description:
      "List the current user's stored credentials (metadata only — secrets never leave the server).",
    sensitivity: 'read',
    inputSchema: CredentialsListInput,
    async execute(ctx: ToolContext, input): Promise<{ items: ReadonlyArray<CredentialMetaDto> }> {
      const args: Parameters<CredentialsService['list']>[0] = {
        userId: ctx.userId,
      };
      if (input.provider !== undefined) {
        (args as { provider?: string }).provider = input.provider;
      }
      const metas = await deps.credentials.list(args);
      const items: CredentialMetaDto[] = metas.map((m) => ({
        id: m.id,
        provider: m.provider,
        kind: m.kind,
        label: m.label,
        prfEnabled: m.prfEnabled,
        createdAt: m.createdAt,
        rotatedAt: m.rotatedAt,
        lastUsedAt: m.lastUsedAt,
        expiresAt: m.expiresAt,
      }));
      return { items };
    },
  };
}

// ---------------------------------------------------------------------------
// credentials.add
// ---------------------------------------------------------------------------

export function makeCredentialsAddTool(
  deps: CredentialsToolsDeps,
): Tool<CredentialsAddInputT, CredentialMetaDto> {
  return {
    name: 'credentials.add',
    description:
      'Store a new credential (PAT, OAuth-refresh, etc.) for a service-provider. Requires approval; PRF-enabled credentials require a prior PRF-eval session.',
    sensitivity: 'write',
    displayTemplate:
      'Add credential: {{label}} ({{provider}} / {{kind}}, prf={{prfEnabled}})',
    inputSchema: CredentialsAddInput,
    async execute(ctx: ToolContext, input): Promise<CredentialMetaDto> {
      // Default: prfEnabled=true (PRF day-zero). Caller kann explizit false setzen.
      const prfEnabled = input.prfEnabled ?? true;

      let prfOutput: Uint8Array | undefined;
      if (prfEnabled) {
        if (!input.prfSessionId) {
          // Kein PRF-Material → Sentinel werfen. Caller resolved + retried.
          throw new PrfRequiredError(null);
        }
        const resolved = await deps.prfSessions.get(input.prfSessionId, ctx.userId);
        if (!resolved) {
          throw new PrfRequiredError(null);
        }
        prfOutput = resolved;
      }

      const createArgs: Parameters<CredentialsService['create']>[0] = {
        userId: ctx.userId,
        provider: input.provider,
        kind: input.kind,
        label: input.label,
        secret: input.secret,
        prfEnabled,
      };
      if (prfOutput !== undefined) {
        (createArgs as { prfOutput?: Uint8Array }).prfOutput = prfOutput;
      }
      if (input.expiresAt !== undefined) {
        (createArgs as { expiresAt?: number }).expiresAt = input.expiresAt;
      }
      if (input.metadata !== undefined) {
        (createArgs as { metadata?: Record<string, unknown> }).metadata = input.metadata;
      }

      const meta = await deps.credentials.create(createArgs);
      return {
        id: meta.id,
        provider: meta.provider,
        kind: meta.kind,
        label: meta.label,
        prfEnabled: meta.prfEnabled,
        createdAt: meta.createdAt,
        rotatedAt: meta.rotatedAt,
        lastUsedAt: meta.lastUsedAt,
        expiresAt: meta.expiresAt,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// credentials.delete — danger
// ---------------------------------------------------------------------------

export function makeCredentialsDeleteTool(
  deps: CredentialsToolsDeps,
): Tool<CredentialsDeleteInputT, { deleted: true; credentialId: string }> {
  return {
    name: 'credentials.delete',
    description:
      'Delete a stored credential. Destructive — also revokes downstream Sub-MCP access.',
    sensitivity: 'danger',
    displayTemplate: 'DELETE credential {{credentialId}}',
    inputSchema: CredentialsDeleteInput,
    async execute(ctx: ToolContext, input): Promise<{ deleted: true; credentialId: string }> {
      await deps.credentials.delete({
        userId: ctx.userId,
        credentialId: input.credentialId,
      });
      return { deleted: true, credentialId: input.credentialId };
    },
  };
}
