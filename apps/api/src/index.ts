import dotenv from 'dotenv';

dotenv.config();

import { sql } from 'drizzle-orm';

import { createApp } from './app.js';
import { createDb, waitForDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { ensureDefaultWorkspace } from './db/seed.js';
import { loadEnv } from './env.js';
import { createLogger } from './logger.js';
import { createStorageFromEnv } from './storage/index.js';
import { API_VERSION } from './version.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env);
  const { client, db } = createDb(env.DATABASE_URL, { max: env.DB_POOL_MAX });
  try {
    // Neon free compute scales to zero and wakes slowly — retry the first
    // query instead of crashing.
    await waitForDb(db, { logger });
    await runMigrations(db);
    const workspace = await ensureDefaultWorkspace(db);
    const storage = createStorageFromEnv(env);
    const app = createApp({
      env,
      logger,
      version: API_VERSION,
      checkDb: async () => {
        await db.execute(sql`SELECT 1`);
      },
      storage,
    });

    const server = app.listen(env.PORT, env.HOST, () => {
      logger.info(
        {
          host: env.HOST,
          port: env.PORT,
          version: API_VERSION,
          workspace: workspace.key,
          storage: storage.name,
          allowPrivateCallbackTargets: env.ALLOW_PRIVATE_CALLBACK_TARGETS,
        },
        'paysim-api ready',
      );
    });

    const shutdown = (signal: string): void => {
      logger.info({ signal }, 'shutting down');
      server.close(() => {
        client
          .end()
          .catch(() => undefined)
          .finally(() => process.exit(0));
      });
      setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
