import { setTimeout as sleep } from 'node:timers/promises';

import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Logger } from 'pino';
import postgres, { type Sql } from 'postgres';

import * as schema from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;

/**
 * Map libpq `sslmode` to a postgres.js `ssl` option.
 * - `require`  -> enforce TLS (Neon pooled strings always carry this)
 * - `disable`  -> plain TCP (local docker-compose Postgres has no TLS)
 * - `prefer`/`allow`/absent -> try TLS, fall back to plain
 * - `verify-ca`/`verify-full` -> rejected: silently downgrading verification
 *   would be worse than failing loudly. Asked-for verification without a CA
 *   bundle cannot be honoured, so boot must fail with a clear message.
 */
export function sslForDatabaseUrl(url: string): false | 'prefer' | 'require' {
  const mode = new URL(url).searchParams.get('sslmode');
  if (mode === null || mode === 'prefer' || mode === 'allow') return 'prefer';
  if (mode === 'disable') return false;
  if (mode === 'require') return 'require';
  throw new Error(
    `Unsupported sslmode=${JSON.stringify(mode)} in DATABASE_URL. ` +
      `Use sslmode=require (Neon), sslmode=disable (local Postgres without TLS), or omit it.`,
  );
}

export interface CreateDbOptions {
  max?: number;
}

/**
 * Single shared postgres.js pool wrapped by Drizzle.
 * `prepare: false` is required for PgBouncer-style pooled endpoints
 * (Neon pooled) and harmless for direct connections.
 */
export function createDb(url: string, options: CreateDbOptions = {}): { client: Sql; db: Db } {
  const client = postgres(url, {
    prepare: false,
    max: options.max ?? 5,
    connect_timeout: 10,
    idle_timeout: 20,
    max_lifetime: 60 * 10,
    ssl: sslForDatabaseUrl(url),
  });
  const db = drizzle(client, { schema });
  return { client, db };
}

export interface WaitForDbOptions {
  logger?: Logger;
  /** Total budget for retries. Neon free compute can take ~30s to wake. */
  maxElapsedMs?: number;
}

/**
 * Retry `SELECT 1` with exponential backoff until the database answers or
 * the budget is spent. Throws the last error on timeout.
 */
export async function waitForDb(db: Db, options: WaitForDbOptions = {}): Promise<void> {
  const maxElapsedMs = options.maxElapsedMs ?? 60_000;
  const started = Date.now();
  let delayMs = 250;
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      await db.execute(sql`SELECT 1`);
      return;
    } catch (err) {
      const elapsedMs = Date.now() - started;
      if (elapsedMs + delayMs > maxElapsedMs) {
        throw err;
      }
      options.logger?.warn({ attempt, elapsedMs, delayMs }, 'database not ready, retrying');
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 5_000);
    }
  }
}
