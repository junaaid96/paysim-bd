// Standalone `pnpm db:migrate` entrypoint for CI and operators.
// The server also migrates on boot (migrations are idempotent).

import '../dotenv.js';

import { loadEnv } from '../env.js';
import { createLogger } from '../logger.js';
import { createDb, waitForDb } from './client.js';
import { runMigrations } from './migrate.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ ...env, LOG_LEVEL: 'info' });
  const { client, db } = createDb(env.DATABASE_URL, { max: 2 });
  try {
    await waitForDb(db, { logger });
    await runMigrations(db);
    logger.info('migrations applied');
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
