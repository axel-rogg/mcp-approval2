/**
 * Environment-Konfiguration via Zod.
 *
 * Plan-Ref: PLAN-architecture-v1.md §13 (Tech-Stack-Confirmation).
 *
 * Beim Start einmal `loadConfig(env)` aufrufen — wirft, wenn ein Pflicht-Var
 * fehlt. Tests und CLI-Skripte koennen mit `loadConfig(process.env)` arbeiten.
 */
import { z } from 'zod';

const ConfigSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  ORIGIN: z.string().url().default('http://localhost:8787'),

  // Datenbank
  DATABASE_URL: z.string().min(1, 'DATABASE_URL required'),
  DATABASE_DIALECT: z.enum(['postgres', 'sqlite']).default('postgres'),

  // Auth / JWT
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be >= 32 chars'),
  JWT_ISSUER: z.string().default('mcp-approval2'),
  JWT_AUDIENCE: z.string().default('mcp-approval2-api'),
  SESSION_TTL_SEC: z.coerce.number().int().positive().default(30 * 60),
  REFRESH_TTL_SEC: z.coerce.number().int().positive().default(30 * 24 * 60 * 60),

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.string().url(),

  // WebAuthn / Passkey
  RP_ID: z.string().min(1).default('localhost'),
  RP_NAME: z.string().default('mcp-approval2'),
  RP_ORIGIN: z.string().url().default('http://localhost:8787'),

  // Invite / Recovery
  INVITE_TTL_SEC: z.coerce.number().int().positive().default(24 * 60 * 60),
  RECOVERY_TTL_SEC: z.coerce.number().int().positive().default(24 * 60 * 60),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}
