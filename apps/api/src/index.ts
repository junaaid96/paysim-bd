import dotenv from 'dotenv';

dotenv.config();

import { sql } from 'drizzle-orm';

import type { DeliverCallbackInput, DeliveryRecord, PluginContext } from '@paysim/core';

import { createApp } from './app.js';
import { DbClock } from './clock.js';
import { createDb, waitForDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import {
  ensureBuiltinScenarios,
  ensureDefaultGatewayApp,
  ensureDefaultWorkspace,
} from './db/seed.js';
import { createEngine } from './engine.js';
import { loadEnv } from './env.js';
import { createDrizzleStores, createQueries } from './stores/drizzle-stores.js';
import { EventBus } from './events/bus.js';
import { deliverCallbackNow, runScheduledRetry, type DeliverDeps } from './deliver.js';
import { scheduleJob } from './jobs.js';
import { adaptPino, createLogger } from './logger.js';
import { loadPlugins } from './plugins.js';
import { Scheduler } from './scheduler.js';
import { createStorageFromEnv } from './storage/index.js';
import type { TxnOpsDeps } from './txn-ops.js';
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
    const bus = new EventBus();
    const clock = new DbClock(db);
    await clock.loadAll();
    const stores = createDrizzleStores({ db, bus, storage });
    const queries = createQueries(db);
    const plugins = loadPlugins();
    for (const plugin of plugins) {
      const app = await ensureDefaultGatewayApp({ queries, stores }, workspace, plugin);
      logger.info({ plugin: plugin.name, app: app.name }, 'gateway app ready');
    }
    const seeded = await ensureBuiltinScenarios(db, plugins);
    if (seeded > 0) logger.info({ seeded }, 'built-in scenarios seeded');

    // Scheduler <-> delivery wiring: delivery failures schedule retry jobs
    // and wake the scheduler. Assigned before the server accepts traffic;
    // scheduleRetry can only run after boot either way.
    let scheduler: Scheduler | null = null;
    const kick = (): void => scheduler?.kick();
    const deliverDeps: DeliverDeps = {
      stores,
      logger: adaptPino(logger),
      allowPrivate: env.ALLOW_PRIVATE_CALLBACK_TARGETS,
      scheduleRetry: async (job) => {
        await scheduleJob(db, {
          workspaceId: job.workspaceId,
          transactionId: job.transactionId,
          type: 'delivery-retry',
          payload: {
            txnId: job.transactionId,
            kind: job.kind,
            targetUrl: job.targetUrl,
            payload: job.payload,
            attempt: job.attempt,
          },
          runAt: job.runAt,
        });
        kick();
      },
    };
    const deliverCallback = (input: DeliverCallbackInput): Promise<DeliveryRecord> =>
      deliverCallbackNow(deliverDeps, input);
    const engine = createEngine({ db, stores, logger: adaptPino(logger), kick });
    const simBaseUrl = env.SIM_BASE_URL?.trim() || `http://localhost:${env.PORT}`;
    const schedulerCtx: PluginContext = {
      stores,
      logger: adaptPino(logger.child({ component: 'scheduler' })),
      clock,
      simBaseUrl,
      deliverCallback,
      engine,
    };
    scheduler = new Scheduler({
      db,
      ctx: schedulerCtx,
      logger: adaptPino(logger.child({ component: 'scheduler' })),
      plugins,
      runRetry: (input) => runScheduledRetry(deliverDeps, input),
    });
    await scheduler.start();

    const ops: TxnOpsDeps = {
      db,
      engineDeps: { db, stores, logger: adaptPino(logger), kick },
      applyDeps: { db, stores, logger: adaptPino(logger), kick, engine, plugins },
      storage,
      deliver: deliverCallback,
    };
    const app = createApp({
      env,
      logger,
      version: API_VERSION,
      checkDb: async () => {
        await db.execute(sql`SELECT 1`);
      },
      storage,
      db,
      plugins,
      stores,
      queries,
      bus,
      clock,
      dbClock: clock,
      simBaseUrl,
      deliverCallback,
      engine,
      ops,
      kick,
    });

    const server = app.listen(env.PORT, env.HOST, () => {
      logger.info(
        {
          host: env.HOST,
          port: env.PORT,
          simBaseUrl,
          version: API_VERSION,
          workspace: workspace.key,
          storage: storage.name,
          plugins: plugins.map((plugin) => plugin.name),
          allowPrivateCallbackTargets: env.ALLOW_PRIVATE_CALLBACK_TARGETS,
        },
        'paysim-api ready',
      );
    });

    const shutdown = (signal: string): void => {
      logger.info({ signal }, 'shutting down');
      scheduler?.stop();
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
