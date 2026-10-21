/* global process, console */
// Vercel serverless entry for the hosted playground.
// The React dashboard is served as static files from apps/web/dist; every
// /api/* request is rewritten here and handled by the same boot sequence as
// `pnpm dev` and Docker (built into apps/api/dist by `pnpm build`).
//
// Scheduling on serverless: in-process timers die when the function is
// frozen, so every request first runs overdue jobs (evaluate-on-read), and
// after the response the function stays alive via waitUntil to run jobs due
// within DRAIN_WINDOW_MS (scenario steps, IPN retries) on time.
import { waitUntil } from '@vercel/functions';
import { bootApp } from '../apps/api/dist/boot.js';
import { loadEnv } from '../apps/api/dist/env.js';
import { createLogger } from '../apps/api/dist/logger.js';
import { FsStorageDriver } from '../apps/api/dist/storage/fs.js';
import { createStorageFromEnv } from '../apps/api/dist/storage/index.js';

let appPromise;

/** Keep draining jobs due this soon after a response (< maxDuration 60s). */
const DRAIN_WINDOW_MS = 45_000;
/** Catch-up costs a DB round trip; do it at most this often per instance. */
const CATCH_UP_EVERY_MS = 5_000;
let lastCatchUp = 0;
let draining = false;

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
  const booted = await bootApp({
    env,
    logger,
    storage: createStorage(env, logger),
    poolMax: Math.min(env.DB_POOL_MAX, 3),
    simBaseUrl: vercelUrl ? `https://${vercelUrl}` : undefined,
  });
  return booted;
}

export default async function handler(req, res) {
  appPromise ??= init().catch((err) => {
    appPromise = undefined;
    throw err;
  });
  try {
    const { app, scheduler } = await appPromise;
    // Catch up anything that came due while no instance was running.
    if (Date.now() - lastCatchUp > CATCH_UP_EVERY_MS) {
      lastCatchUp = Date.now();
      await scheduler.runDueNow().catch((err) => console.error('catch-up failed', err?.message));
    }
    res.on('finish', () => {
      // One drain loop per instance is enough; it re-checks the queue.
      if (draining) return;
      draining = true;
      waitUntil(
        scheduler
          .drainUntil(Date.now() + DRAIN_WINDOW_MS)
          .catch((err) => console.error('drain failed', err?.message))
          .finally(() => {
            draining = false;
          }),
      );
    });
    return app(req, res);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'service_unavailable' }));
  }
}
