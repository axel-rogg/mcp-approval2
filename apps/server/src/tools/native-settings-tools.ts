/**
 * Native-Settings-Tool — `native_settings`.
 *
 * Plan-Ref: docs/plans/done/PLAN-prefs.md (mcp-approval), portiert nach Burst 3.
 *
 * Read-only Discovery-Tool, das die operativen Server-Settings liefert die ein
 * MCP-Client (PWA, externer Agent) braucht um sich auf den Hub zu orientieren:
 *   - Origin / RP-ID (WebAuthn-Setup-Pfad)
 *   - Authentication-Modi (Google-OAuth + WebAuthn)
 *   - JWT/Session-TTL
 *   - Hub-Version / Service-Name
 *
 * Bewusst KEINE Secret-Werte (JWT_SECRET, OAuth-Client-Secret, etc.) — sondern
 * nur das, was dem User-Client offiziell mitgeteilt werden darf.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';
import type { AppConfig } from '../lib/config.js';

export const NativeSettingsInput = z.object({}).strict();
export type NativeSettingsInputT = z.infer<typeof NativeSettingsInput>;

export interface NativeSettingsResult {
  readonly service: string;
  readonly origin: string;
  readonly webauthn: {
    readonly rpId: string;
    readonly rpName: string;
    readonly rpOrigin: string;
  };
  readonly auth: {
    readonly modes: ReadonlyArray<'google_oauth' | 'webauthn'>;
    readonly sessionTtlSec: number;
    readonly refreshTtlSec: number;
  };
  readonly nodeEnv: 'development' | 'test' | 'production';
}

export interface NativeSettingsDeps {
  readonly config: AppConfig;
}

export function makeNativeSettingsTool(
  deps: NativeSettingsDeps,
): Tool<NativeSettingsInputT, NativeSettingsResult> {
  return {
    name: 'native_settings',
    description:
      'Read-only: liefert non-secret Server-Settings (origin, webauthn-RP, auth-modes, ttl). Keine Tokens.',
    sensitivity: 'read',
    inputSchema: NativeSettingsInput,
    async execute(_ctx: ToolContext): Promise<NativeSettingsResult> {
      return {
        service: 'mcp-approval2',
        origin: deps.config.ORIGIN,
        webauthn: {
          rpId: deps.config.RP_ID,
          rpName: deps.config.RP_NAME,
          rpOrigin: deps.config.RP_ORIGIN,
        },
        auth: {
          modes: ['google_oauth', 'webauthn'] as const,
          sessionTtlSec: deps.config.SESSION_TTL_SEC,
          refreshTtlSec: deps.config.REFRESH_TTL_SEC,
        },
        nodeEnv: deps.config.NODE_ENV,
      };
    },
  };
}
