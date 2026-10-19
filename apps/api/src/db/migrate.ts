import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/postgres-js/migrator';

import type { Db } from './client.js';

/**
 * Resolves to apps/api/drizzle both from src/ (tsx) and dist/ (node),
 * because the build mirrors src/ into dist/.
 */
export function migrationsFolder(): string {
  return fileURLToPath(new URL('../../drizzle', import.meta.url));
}

/**
 * Apply pending migrations. Idempotent: already-applied migrations are
 * recorded in __drizzle_migrations and skipped, so this is safe to run on
 * every boot and to re-run by hand.
 */
export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsFolder() });
}
