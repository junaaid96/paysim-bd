// Shared harness for DB-backed integration tests. Each file gets a fresh
// truncated database, a real engine + scheduler + plugin stack, and a
// fake-callback receiver. Files run serially (fileParallelism: false).

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import type { Sql } from 'postgres';

import type {
  AppRecord,
  DeliverCallbackInput,
  DeliveryRecord,
  GatewayPlugin,
  PluginContext,
  PluginLogger,
  PluginStores,
  TxnRecord,
} from '@paysim/core';

import { DbClock } from '../src/clock.js';
import { createDb, waitForDb, type Db } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { ensureBuiltinScenarios, ensureDefaultWorkspace } from '../src/db/seed.js';
import {
  deliverCallbackNow,
  runScheduledRetry,
  type DeliverDeps,
  type ScheduleRetryJob,
} from '../src/deliver.js';
import { createEngine, type ApplyOverrideDeps, type EngineDeps } from '../src/engine.js';
import { EventBus } from '../src/events/bus.js';
import { scheduleJob, shiftPendingJobs } from '../src/jobs.js';
import { loadPlugins } from '../src/plugins.js';
import { Scheduler } from '../src/scheduler.js';
import { FsStorageDriver } from '../src/storage/fs.js';
import type { StorageAdapter } from '../src/storage/index.js';
import { createDrizzleStores, createQueries, type Queries } from '../src/stores/drizzle-stores.js';
import type { TxnOpsDeps } from '../src/txn-ops.js';

export const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface ReceivedPost {
  body: string;
  fields: Record<string, string>;
}

export interface TestReceiver {
  url: string;
  posts: ReceivedPost[];
  close: () => Promise<void>;
}

export async function startReceiver(status = 200): Promise<TestReceiver> {
  const posts: ReceivedPost[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      const fields: Record<string, string> = {};
      for (const [key, value] of new URLSearchParams(body)) {
        fields[key] = value;
      }
      posts.push({ body, fields });
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end(status === 200 ? 'ok' : 'down');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/ipn`,
    posts,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export interface TestHost {
  client: Sql;
  db: Db;
  workspace: { id: string; key: string; name: string };
  clock: DbClock;
  stores: PluginStores;
  queries: Queries;
  plugins: GatewayPlugin[];
  engineDeps: EngineDeps;
  applyDeps: ApplyOverrideDeps;
  deliverDeps: DeliverDeps;
  ctx: PluginContext;
  scheduler: Scheduler;
  app: AppRecord;
  scheduledRetries: ScheduleRetryJob[];
  bus: EventBus;
  storage: StorageAdapter;
  ops: TxnOpsDeps;
  kick: () => void;
  seedTxn: (overrides?: {
    ipnUrl?: string | null;
    state?: string;
    gatewayTxnId?: string;
    expiresAt?: Date | null;
    valueD?: string;
  }) => Promise<TxnRecord>;
  waitFor: (check: () => Promise<boolean>, what: string, timeoutMs?: number) => Promise<void>;
  /** Mirror of the clock routes: jump, shift fake-timeline jobs, kick. */
  jumpClock: (deltaMs: number) => Promise<number>;
  resetClock: () => Promise<number>;
  cleanup: () => Promise<void>;
}

let txnSequence = 0;

export async function createTestHost(): Promise<TestHost> {
  const testUrl = process.env['TEST_DATABASE_URL'];
  if (!testUrl) throw new Error('TEST_DATABASE_URL is required');
  const { client, db } = createDb(testUrl, { max: 2 });
  await waitForDb(db, { maxElapsedMs: 20_000 });
  await runMigrations(db);
  await db.execute(
    sql`TRUNCATE workspaces, scenarios, gateway_apps, transactions, events, callback_deliveries, clock_state, recordings, jobs`,
  );

  const workspaceRow = await ensureDefaultWorkspace(db);
  const workspace = { id: workspaceRow.id, key: workspaceRow.key, name: workspaceRow.name };
  const storageDir = await mkdtemp(join(tmpdir(), 'paysim-blobs-'));
  const storage = new FsStorageDriver(storageDir);
  const bus = new EventBus();
  const clock = new DbClock(db);
  await clock.loadAll();
  const stores = createDrizzleStores({ db, bus, storage });
  const queries = createQueries(db);
  const plugins: GatewayPlugin[] = loadPlugins();
  await ensureBuiltinScenarios(db, plugins);
  const app = await queries.createApp({
    workspaceId: workspace.id,
    gateway: 'sslcommerz',
    name: 'Test store',
    credentials: { store_id: 'testbox', store_passwd: 'qwerty' },
  });

  let scheduler: Scheduler | null = null;
  const kick = (): void => scheduler?.kick();
  const engine = createEngine({ db, stores, logger: silentLogger, kick });
  const scheduledRetries: ScheduleRetryJob[] = [];
  const deliverDeps: DeliverDeps = {
    stores,
    logger: silentLogger,
    allowPrivate: true,
    scheduleRetry: async (job) => {
      scheduledRetries.push(job);
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
  const ctx: PluginContext = {
    stores,
    logger: silentLogger,
    clock,
    simBaseUrl: 'http://sim.test',
    deliverCallback,
    engine,
  };
  scheduler = new Scheduler({
    db,
    ctx,
    logger: silentLogger,
    plugins,
    runRetry: (input) => runScheduledRetry(deliverDeps, input),
  });
  await scheduler.start();

  const engineDeps: EngineDeps = { db, stores, logger: silentLogger, kick };
  const applyDeps: ApplyOverrideDeps = { ...engineDeps, engine, plugins };

  async function seedTxn(
    overrides: {
      ipnUrl?: string | null;
      state?: string;
      gatewayTxnId?: string;
      expiresAt?: Date | null;
      valueD?: string;
    } = {},
  ): Promise<TxnRecord> {
    txnSequence += 1;
    return stores.createTransaction({
      workspaceId: workspace.id,
      gatewayAppId: app.id,
      gateway: 'sslcommerz',
      state: overrides.state ?? 'initiated',
      gatewayTxnId: overrides.gatewayTxnId ?? `TEST-${txnSequence}`,
      gatewaySessionKey: `SESS-${txnSequence}-${Date.now()}`,
      amountMinor: 10300,
      currency: 'BDT',
      customer: { cus_name: 'Test Customer' },
      metadata: {
        storeId: 'testbox',
        currencyType: 'BDT',
        productCategory: 'test',
        successUrl: 'http://client.test/pay/success',
        failUrl: 'http://client.test/pay/fail',
        cancelUrl: 'http://client.test/pay/cancel',
        ipnUrl: overrides.ipnUrl === undefined ? 'http://client.test/pay/ipn' : overrides.ipnUrl,
        valueA: 'ref001',
        valueB: '',
        valueC: '',
        valueD: overrides.valueD ?? '',
        ship: {},
      },
      ...(overrides.expiresAt === null
        ? {}
        : { expiresAt: overrides.expiresAt ?? new Date(Date.now() + 3_600_000) }),
    });
  }

  async function waitFor(
    check: () => Promise<boolean>,
    what: string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const started = Date.now();
    for (;;) {
      if (await check()) return;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for ${what}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function jumpClock(deltaMs: number): Promise<number> {
    const before = clock.offsetMs(workspace.id);
    const view = await clock.advance(workspace.id, deltaMs);
    const shifted = await shiftPendingJobs(db, workspace.id, view.offsetMs - before, [
      'scenario-step',
      'session-expiry',
    ]);
    kick();
    return shifted;
  }

  async function resetClock(): Promise<number> {
    const before = clock.offsetMs(workspace.id);
    const view = await clock.reset(workspace.id);
    const shifted = await shiftPendingJobs(db, workspace.id, view.offsetMs - before, [
      'scenario-step',
      'session-expiry',
    ]);
    kick();
    return shifted;
  }

  async function cleanup(): Promise<void> {
    scheduler?.stop();
    await client.end();
    await rm(storageDir, { recursive: true, force: true });
  }

  return {
    client,
    db,
    workspace,
    clock,
    stores,
    queries,
    plugins,
    engineDeps,
    applyDeps,
    deliverDeps,
    ctx,
    scheduler,
    app,
    scheduledRetries,
    seedTxn,
    waitFor,
    jumpClock,
    resetClock,
    cleanup,
    bus,
    storage,
    ops: { db, engineDeps, applyDeps, storage, deliver: deliverCallback },
    kick,
  };
}
