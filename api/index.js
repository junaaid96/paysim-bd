/* global process, console */
// Vercel serverless entry for the hosted playground.
// The React dashboard is served as static files from apps/web/dist; every
// /api/* request is rewritten here and handled by the same boot sequence as
// `pnpm dev` and Docker (built into apps/api/dist by `pnpm build`).
//
// Serverless caveat: in-process scheduler timers only run while the function
// is warm, so scenario steps and delivery retries fire on invocation (cold
// starts process anything overdue) rather than precisely on time.
import { bootApp } from '../apps/api/dist/boot.js';
import { loadEnv } from '../apps/api/dist/env.js';
import { createLogger } from '../apps/api/dist/logger.js';
import { FsStorageDriver } from '../apps/api/dist/storage/fs.js';
import { createStorageFromEnv } from '../apps/api/dist/storage/index.js';

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
  // Production deployments should emit the stable production hostname in
  // GatewayPageURL/callbacks, not the deployment-specific VERCEL_URL.
  const vercelUrl = (
    process.env.VERCEL_PROJECT_PRODUCTION_URL ??
    process.env.VERCEL_URL ??
    ''
  ).trim();
  const { app } = await bootApp({
    env,
    logger,
    storage: createStorage(env, logger),
    poolMax: Math.min(env.DB_POOL_MAX, 3),
    simBaseUrl: vercelUrl ? `https://${vercelUrl}` : undefined,
  });
  return app;
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
