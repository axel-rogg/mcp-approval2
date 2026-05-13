/**
 * Database-Adapter-Instantiation.
 *
 * Plan-Ref: PLAN-architecture-v1.md §7 (Storage), §13 (Tech-Stack).
 *
 * Faehrt entweder `PostgresDbAdapter` (primary self-host) oder
 * `SqliteDbAdapter` (Tests/Dev) basierend auf `config.DATABASE_DIALECT`.
 */
import {
  PostgresDbAdapter,
  SqliteDbAdapter,
  type DbAdapter,
} from '@mcp-approval2/adapters';
import type { AppConfig } from './config.js';

export async function createDbAdapter(config: AppConfig): Promise<DbAdapter> {
  if (config.DATABASE_DIALECT === 'postgres') {
    return new PostgresDbAdapter({ url: config.DATABASE_URL });
  }
  return new SqliteDbAdapter({ filename: config.DATABASE_URL });
}
