import { eq, sql } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, waitForDb, type Db } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { callbackDeliveries, events, gatewayApps, transactions } from '../src/db/schema.js';
import { ensureDefaultWorkspace } from '../src/db/seed.js';

// Only runs when a scratch database is provided (CI service / local test db).
// The suite creates tables and truncates them — never point it at real data.
const TEST_URL = process.env['TEST_DATABASE_URL'];
const maybe = TEST_URL ? describe : describe.skip;

maybe('db integration', () => {
  let client: Sql;
  let db: Db;

  beforeAll(async () => {
    const created = createDb(TEST_URL as string, { max: 2 });
    client = created.client;
    db = created.db;
    await waitForDb(db, { maxElapsedMs: 20_000 });
    // Migrating twice proves migrations are idempotent.
    await runMigrations(db);
    await runMigrations(db);
    await db.execute(
      sql`TRUNCATE workspaces, scenarios, gateway_apps, transactions, events, callback_deliveries, clock_state, recordings, jobs`,
    );
  }, 60_000);

  afterAll(async () => {
    await client.end();
  });

  it('seeds the default workspace idempotently', async () => {
    const first = await ensureDefaultWorkspace(db);
    const second = await ensureDefaultWorkspace(db);
    expect(first.id).toBe(second.id);
    expect(first.key).toBe('local-default');
  });

  it('round-trips a transaction with events and deliveries, then cascades', async () => {
    const workspace = await ensureDefaultWorkspace(db);
    const [app] = await db
      .insert(gatewayApps)
      .values({
        workspaceId: workspace.id,
        gateway: 'sslcommerz',
        name: 'Test store',
        credentials: { store_id: 'testbox' },
      })
      .returning();
    const [txn] = await db
      .insert(transactions)
      .values({
        workspaceId: workspace.id,
        gatewayAppId: app.id,
        gateway: 'sslcommerz',
        state: 'initiated',
        amountMinor: 150_000,
        currency: 'BDT',
      })
      .returning();
    await db.insert(events).values({
      workspaceId: workspace.id,
      transactionId: txn.id,
      type: 'transaction.created',
      data: { state: 'initiated' },
    });
    await db.insert(callbackDeliveries).values({
      workspaceId: workspace.id,
      transactionId: txn.id,
      kind: 'ipn',
      targetUrl: 'http://localhost:4000/ipn',
      status: 'scheduled',
    });

    const timeline = await db.select().from(events).where(eq(events.transactionId, txn.id));
    expect(timeline).toHaveLength(1);
    expect(timeline[0].type).toBe('transaction.created');

    const pending = await db
      .select()
      .from(callbackDeliveries)
      .where(eq(callbackDeliveries.transactionId, txn.id));
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe('scheduled');
    expect(pending[0].attemptNo).toBe(1);

    // Deleting the transaction cascades to its events and deliveries.
    await db.delete(transactions).where(eq(transactions.id, txn.id));
    expect(await db.select().from(events).where(eq(events.transactionId, txn.id))).toHaveLength(0);
    expect(
      await db
        .select()
        .from(callbackDeliveries)
        .where(eq(callbackDeliveries.transactionId, txn.id)),
    ).toHaveLength(0);
  });
});
