import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SystemClock } from '@paysim/core';

import { createDb, waitForDb, type Db } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { ensureDefaultWorkspace } from '../src/db/seed.js';
import { EventBus } from '../src/events/bus.js';
import { FsStorageDriver } from '../src/storage/fs.js';
import { createDrizzleStores, createQueries, type Queries } from '../src/stores/drizzle-stores.js';
import type { PluginStores } from '@paysim/core';

const TEST_URL = process.env['TEST_DATABASE_URL'];
const maybe = TEST_URL ? describe : describe.skip;

maybe('drizzle stores integration', () => {
  let client: Sql;
  let db: Db;
  let stores: PluginStores;
  let queries: Queries;
  let blobRoot = '';
  const seen: string[] = [];

  beforeAll(async () => {
    const created = createDb(TEST_URL as string, { max: 2 });
    client = created.client;
    db = created.db;
    await waitForDb(db, { maxElapsedMs: 20_000 });
    await runMigrations(db);
    await db.execute(
      sql`TRUNCATE workspaces, scenarios, gateway_apps, transactions, events, callback_deliveries, clock_state, recordings, jobs, kv_entries`,
    );
    blobRoot = await mkdtemp(join(tmpdir(), 'paysim-stores-'));
    const bus = new EventBus();
    bus.subscribe('local-default', (message) => seen.push(message.type));
    stores = createDrizzleStores({ db, bus, storage: new FsStorageDriver(blobRoot) });
    queries = createQueries(db);
  }, 60_000);

  afterAll(async () => {
    await client.end();
    await rm(blobRoot, { recursive: true, force: true });
  });

  it('creates apps, transitions txns and publishes to the bus', async () => {
    const workspace = await ensureDefaultWorkspace(db);
    const app = await queries.createApp({
      workspaceId: workspace.id,
      gateway: 'sslcommerz',
      name: 'Store',
      credentials: { store_id: 'testbox', store_passwd: 'qwerty' },
    });
    expect(app.workspaceKey).toBe('local-default');

    const found = await stores.findAppByStoreId('sslcommerz', 'store_id', 'testbox');
    expect(found?.id).toBe(app.id);

    const txn = await stores.createTransaction({
      workspaceId: workspace.id,
      gatewayAppId: app.id,
      gateway: 'sslcommerz',
      state: 'initiated',
      gatewayTxnId: 'T1',
      gatewaySessionKey: 'S1',
      amountMinor: 10000,
      currency: 'BDT',
      metadata: { valId: 'V1' },
    });
    expect(txn.expiresAt).toBeNull();

    const byValId = await stores.findTransactionByMetadata('sslcommerz', 'valId', 'V1');
    expect(byValId?.id).toBe(txn.id);

    const updated = await stores.transitionTransaction(
      txn.id,
      'valid',
      'sslcommerz.checkout.success',
      { sessionkey: 'S1' },
      { validatedCount: 1 },
    );
    expect(updated.state).toBe('valid');
    expect(updated.metadata['validatedCount']).toBe(1);

    const detail = await queries.getTransactionDetail(txn.id);
    expect(detail?.events.map((event) => event.type)).toEqual([
      'transaction.created',
      'sslcommerz.checkout.success',
    ]);

    expect(seen).toContain('txn.created');
    expect(seen).toContain('txn.updated');
    expect(seen).toContain('event.created');
  });

  it('spills large delivery bodies to object storage', async () => {
    const workspace = await ensureDefaultWorkspace(db);
    const [app] = await queries.listApps('local-default');
    if (!app) throw new Error('expected seeded app');
    const txn = await stores.createTransaction({
      workspaceId: workspace.id,
      gatewayAppId: app.id,
      gateway: 'sslcommerz',
      state: 'initiated',
      amountMinor: 100,
      currency: 'BDT',
    });
    const big = 'x'.repeat(20_000);
    const delivery = await stores.recordDelivery({
      workspaceId: workspace.id,
      transactionId: txn.id,
      kind: 'ipn',
      targetUrl: 'http://localhost:4000/ipn',
      status: 'delivered',
      requestBody: big,
      responseStatus: 200,
      responseSnippet: 'ok',
      responseBody: big,
    });
    expect(delivery.requestBodyKey).toMatch(/^callback-requests\//);
    expect(delivery.responseBodyKey).toMatch(/^callback-responses\//);
    expect(delivery.requestBody).not.toBeNull();

    const small = await stores.recordDelivery({
      workspaceId: workspace.id,
      transactionId: txn.id,
      kind: 'ipn',
      targetUrl: 'http://localhost:4000/ipn',
      status: 'delivered',
      requestBody: 'a=b',
    });
    expect(small.requestBody).toBe('a=b');
    expect(small.requestBodyKey).toBeNull();
  });

  it('spills large event payloads (e.g. huge inbound bodies) to object storage', async () => {
    const workspace = await ensureDefaultWorkspace(db);
    const [app] = await queries.listApps('local-default');
    if (!app) throw new Error('expected seeded app');
    const txn = await stores.createTransaction({
      workspaceId: workspace.id,
      gatewayAppId: app.id,
      gateway: 'sslcommerz',
      state: 'initiated',
      amountMinor: 100,
      currency: 'BDT',
    });
    const event = await stores.recordEvent({
      workspaceId: workspace.id,
      transactionId: txn.id,
      type: 'sslcommerz.init.received',
      data: { body: { value_a: 'y'.repeat(20_000) } },
    });
    expect(event.data['spilled']).toBe(true);
    expect(String(event.data['bodyKey'])).toMatch(/^event-bodies\//);
    const small = await stores.recordEvent({
      workspaceId: workspace.id,
      transactionId: txn.id,
      type: 'note',
      data: { a: 1 },
    });
    expect(small.data).toEqual({ a: 1 });
  });

  it('scopes merchant references (tran_id) to the gateway app', async () => {
    const workspace = await ensureDefaultWorkspace(db);
    const make = (name: string, storeId: string) =>
      queries.createApp({
        workspaceId: workspace.id,
        gateway: 'sslcommerz',
        name,
        credentials: { store_id: storeId, store_passwd: 'x' },
      });
    const a = await make('A', 'scope-a');
    const b = await make('B', 'scope-b');
    const base = {
      workspaceId: workspace.id,
      gateway: 'sslcommerz',
      state: 'initiated',
      amountMinor: 100,
      currency: 'BDT',
      gatewayTxnId: 'SAME-REF',
    };
    const ta = await stores.createTransaction({ ...base, gatewayAppId: a.id });
    const tb = await stores.createTransaction({ ...base, gatewayAppId: b.id });
    expect((await stores.findTransactionByGatewayTxnId('sslcommerz', 'SAME-REF', a.id))?.id).toBe(
      ta.id,
    );
    expect((await stores.findTransactionByGatewayTxnId('sslcommerz', 'SAME-REF', b.id))?.id).toBe(
      tb.id,
    );
    await expect(stores.createTransaction({ ...base, gatewayAppId: a.id })).rejects.toThrow();
  });

  it('shares kv entries and hides expired ones', async () => {
    const kv = stores.kv;
    if (!kv) throw new Error('expected kv');
    await kv.set('t', 'k', { v: 1 }, new Date(Date.now() + 60_000));
    expect(await kv.get('t', 'k')).toEqual({ v: 1 });
    await kv.set('t', 'old', { v: 2 }, new Date(Date.now() - 1));
    expect(await kv.get('t', 'old')).toBeNull();
    await kv.delete('t', 'k');
    expect(await kv.get('t', 'k')).toBeNull();
  });

  it('assigns per-transaction attempt numbers and lists deliveries in order', async () => {
    const workspace = await ensureDefaultWorkspace(db);
    const [app] = await queries.listApps('local-default');
    if (!app) throw new Error('expected seeded app');
    const txn = await stores.createTransaction({
      workspaceId: workspace.id,
      gatewayAppId: app.id,
      gateway: 'sslcommerz',
      state: 'initiated',
      amountMinor: 100,
      currency: 'BDT',
    });
    const first = await stores.recordDelivery({
      workspaceId: workspace.id,
      transactionId: txn.id,
      kind: 'ipn',
      targetUrl: 'http://localhost:4000/ipn',
      status: 'failed',
    });
    const second = await stores.recordDelivery({
      workspaceId: workspace.id,
      transactionId: txn.id,
      kind: 'ipn',
      targetUrl: 'http://localhost:4000/ipn',
      status: 'delivered',
    });
    expect(first.attemptNo).toBe(1);
    expect(second.attemptNo).toBe(2);
    const listed = await stores.listDeliveries(txn.id);
    expect(listed.map((delivery) => delivery.attemptNo)).toEqual([1, 2]);
  });

  it('updates amounts with a metadata patch and no implicit event', async () => {
    const workspace = await ensureDefaultWorkspace(db);
    const [app] = await queries.listApps('local-default');
    if (!app) throw new Error('expected seeded app');
    const txn = await stores.createTransaction({
      workspaceId: workspace.id,
      gatewayAppId: app.id,
      gateway: 'sslcommerz',
      state: 'initiated',
      amountMinor: 100,
      currency: 'BDT',
    });
    const before = (await queries.getTransactionDetail(txn.id))?.events.length ?? 0;
    const updated = await stores.setTransactionAmount(txn.id, 250, { scenarioMutated: true });
    expect(updated.amountMinor).toBe(250);
    expect(updated.metadata['scenarioMutated']).toBe(true);
    expect((await queries.getTransactionDetail(txn.id))?.events.length).toBe(before);
  });

  it('filters transaction lists', async () => {
    const all = await queries.listTransactions({ workspaceKey: 'local-default' });
    expect(all.length).toBeGreaterThanOrEqual(2);
    const valid = await queries.listTransactions({ workspaceKey: 'local-default', state: 'valid' });
    expect(valid.every((txn) => txn.state === 'valid')).toBe(true);
    expect(await queries.listTransactions({ workspaceKey: 'nope' })).toEqual([]);
  });

  it('uses the injected clock only for reads (sanity: SystemClock)', () => {
    expect(new SystemClock().now('local-default')).toBeInstanceOf(Date);
  });
});
