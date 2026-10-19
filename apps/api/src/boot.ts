// Shared boot sequence for every host: long-lived server (index.ts) and
// serverless (api/index.js on Vercel). One place wires stores, engine,
// scheduler and routers so the hosts cannot drift apart again.

import { sql } from 'drizzle-orm';
import type { Application } from 'express';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';

import type { DeliverCallbackInput, DeliveryRecord, PluginContext } from '@paysim/core';

import { createApp } from './app.js';
import { DbClock } from './clock.js';
import { createDb, waitForDb, type Db } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import {
  ensureBuiltinScenarios,
  ensureDefaultGatewayApp,
  ensureDefaultWorkspace,
} from './db/seed.js';
import { createEngine } from './engine.js';
import type { Env } from './env.js';
import { EventBus } from './events/bus.js';
import { deliverCallbackNow, runScheduledRetry, type DeliverDeps } from './deliver.js';
import { scheduleJob } from './jobs.js';
import { adaptPino } from './logger.js';
import { loadPlugins } from './plugins.js';
import { Scheduler } from './scheduler.js';
import { createDrizzleStores, createQueries } from './stores/drizzle-stores.js';
import type { StorageAdapter } from './storage/index.js';
import type { TxnOpsDeps } from './txn-ops.js';
import { API_VERSION } from './version.js';

export interface BootOptions {
  env: Env;
  logger: Logger;
  /** Built by the caller: persistent hosts use createStorageFromEnv. */
  storage: StorageAdapter;
  /** Max DB connections (serverless passes a small cap). */
  poolMax?: number;
  /** Base URL for GatewayPageURL etc. Defaults to SIM_BASE_URL or localhost. */
  simBaseUrl?: string;
  /** Skip migrations (tests manage schema themselves). Default: run. */
  migrate?: boolean;
}

export interface BootedApp {
  app: Application;
  scheduler: Scheduler;
  client: Sql;
  db: Db;
  workspaceKey: string;
  storageName: string;
  pluginNames: string[];
  simBaseUrl: string;
}

export async function bootApp(options: BootOptions): Promise<BootedApp> {
  const { env, logger, storage } = options;
  const { client, db } = createDb(env.DATABASE_URL, { max: options.poolMax ?? env.DB_POOL_MAX });
  try {
    // Neon free compute scales to zero and wakes slowly — retry the first
    // query instead of crashing.
    await waitForDb(db, { logger });
    if (options.migrate !== false) {
      await runMigrations(db);
    }
    const workspace = await ensureDefaultWorkspace(db);
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
    const simBaseUrl =
      options.simBaseUrl || env.SIM_BASE_URL?.trim() || `http://localhost:${env.PORT}`;
    const schedulerCtx: PluginContext = {
      stores,
      logger: adaptPino(logger.child({ component: 'scheduler' })),
      clock,
      simBaseUrl: simBaseUrl,
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
      simBaseUrl: simBaseUrl,
      deliverCallback,
      engine,
      ops,
      kick,
    });
    return {
      app,
      scheduler,
      client,
      db,
      workspaceKey: workspace.key,
      storageName: storage.name,
      pluginNames: plugins.map((plugin) => plugin.name),
      simBaseUrl: simBaseUrl,
    };
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }
}
