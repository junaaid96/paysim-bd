import dotenv from 'dotenv';

dotenv.config();

import { bootApp } from './boot.js';
import { loadEnv } from './env.js';
import { createLogger } from './logger.js';
import { createStorageFromEnv } from './storage/index.js';
import { API_VERSION } from './version.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env);
  const storage = createStorageFromEnv(env);
  const booted = await bootApp({ env, logger, storage });

  const server = booted.app.listen(env.PORT, env.HOST, () => {
    logger.info(
      {
        host: env.HOST,
        port: env.PORT,
        simBaseUrl: booted.simBaseUrl,
        version: API_VERSION,
        workspace: booted.workspaceKey,
        storage: booted.storageName,
        plugins: booted.pluginNames,
        allowPrivateCallbackTargets: env.ALLOW_PRIVATE_CALLBACK_TARGETS,
      },
      'paysim-api ready',
    );
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    booted.scheduler.stop();
    server.close(() => {
      booted.client
        .end()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
