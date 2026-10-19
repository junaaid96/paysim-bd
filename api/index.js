/* global process, console */
// Vercel serverless entry for the hosted playground.
// The React dashboard is served as static files from apps/web/dist; every
// /api/* request is rewritten here and handled by the same Express app that
// `pnpm dev` and Docker run (built into apps/api/dist by `pnpm build`).
import { createApp } from '../apps/api/dist/app.js';
import { createDb, waitForDb } from '../apps/api/dist/db/client.js';
import { runMigrations } from '../apps/api/dist/db/migrate.js';
import { ensureDefaultWorkspace } from '../apps/api/dist/db/seed.js';
import { loadEnv } from '../apps/api/dist/env.js';
import { createLogger } from '../apps/api/dist/logger.js';
import { FsStorageDriver } from '../apps/api/dist/storage/fs.js';
import { createStorageFromEnv } from '../apps/api/dist/storage/index.js';
import { API_VERSION } from '../apps/api/dist/version.js';

let appPromise;

function createStorage(env, logger) {
  if (env.STORAGE_DRIVER === 's3') return createStorageFromEnv(env);
  // No S3/R2 credentials configured: fall back to the function's /tmp disk.
  // It is ephemeral, so large bodies do not survive cold starts.
  logger.warn('STORAGE_DRIVER is not s3; using ephemeral /tmp storage');
  return new FsStorageDriver('/tmp/paysim-blobs');
}

async function init() {
  const env = loadEnv(process.env);
  const logger = createLogger(env);
  const { client, db } = createDb(env.DATABASE_URL, { max: Math.min(env.DB_POOL_MAX, 3) });
  await waitForDb(db, { logger, maxElapsedMs: 30_000 });
  await runMigrations(db);
  await ensureDefaultWorkspace(db);
  return createApp({
    env,
    logger,
    version: API_VERSION,
    checkDb: async () => {
      await client`SELECT 1`;
    },
    storage: createStorage(env, logger),
  });
}

export default async function handler(req, res) {
  appPromise ??= init().catch((err) => {
    appPromise = undefined;
    throw err;
  });
  try {
    const app = await appPromise;
    return app(req, res);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'service_unavailable' }));
  }
}
