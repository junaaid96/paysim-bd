// Scheduler execution, delivery retries, overrides and replays against a
// live stack. Needs TEST_DATABASE_URL (serial with other files).

import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ScenarioDefinitionSchema } from '@paysim/core';

import { jobs } from '../src/db/schema.js';
import { TerminalOverrideError } from '../src/engine.js';
import { runScheduledRetry } from '../src/deliver.js';
import { Scheduler } from '../src/scheduler.js';
import { createScenario } from '../src/scenarios.js';
import { DeliveryNotFoundError, applyTxnScenario, replayDelivery } from '../src/txn-ops.js';
import { createTestHost, startReceiver, type TestHost, type TestReceiver } from './host-harness.js';

const TEST_URL = process.env['TEST_DATABASE_URL'];
const maybe = TEST_URL ? describe : describe.skip;

async function eventTypes(host: TestHost, txnId: string): Promise<string[]> {
  const detail = await host.queries.getTransactionDetail(txnId);
  return detail?.events.map((event) => event.type) ?? [];
}

async function txnState(host: TestHost, txnId: string): Promise<string | null> {
  return (await host.stores.getTransaction(txnId))?.state ?? null;
}

async function pendingJobs(host: TestHost, txnId: string): Promise<string[]> {
  const rows = await host.db
    .select({ type: jobs.type })
    .from(jobs)
    .where(and(eq(jobs.transactionId, txnId), eq(jobs.status, 'pending')));
  return rows.map((row) => row.type);
}

maybe('scheduler integration', () => {
  let host: TestHost;
  const receivers: TestReceiver[] = [];

  beforeAll(async () => {
    host = await createTestHost();
  }, 60_000);

  afterAll(async () => {
    for (const receiver of receivers.splice(0)) {
      await receiver.close();
    }
    await host.cleanup();
  });

  afterEach(async () => {
    for (const receiver of receivers.splice(0)) {
      await receiver.close();
    }
  });

  async function attachBuiltin(txnId: string, name: string): Promise<void> {
    const txn = await host.stores.getTransaction(txnId);
    if (!txn) throw new Error(`Missing txn ${txnId}`);
    const resolved = await host.ctx.engine.resolveForInit({
      workspaceId: host.workspace.id,
      gateway: 'sslcommerz',
      defaultScenarioId: null,
      magicName: name,
    });
    await host.ctx.engine.attach({
      txn,
      scenarioId: resolved.scenarioId,
      definition: resolved.definition,
      source: resolved.source,
    });
  }

  it('runs immediate-success end to end with a real IPN POST', async () => {
    const receiver = await startReceiver();
    receivers.push(receiver);
    const txn = await host.seedTxn({ ipnUrl: receiver.url });
    await attachBuiltin(txn.id, 'immediate-success');

    await host.waitFor(async () => (await txnState(host, txn.id)) === 'valid', 'txn to settle');
    await host.waitFor(
      async () => (await eventTypes(host, txn.id)).includes('scenario.ended'),
      'scenario to end',
    );
    expect(receiver.posts).toHaveLength(1);
    expect(receiver.posts[0]?.fields['status']).toBe('VALID');
    expect(receiver.posts[0]?.fields['tran_id']).toBe(txn.gatewayTxnId);
    const types = await eventTypes(host, txn.id);
    expect(types).toContain('scenario.attached');
    expect(types).toContain('sslcommerz.checkout.success');

    const deliveries = await host.stores.listDeliveries(txn.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ kind: 'ipn', status: 'delivered', attemptNo: 1 });
    expect(await pendingJobs(host, txn.id)).toContain('session-expiry');
  });

  it('runs multi-step scenarios in order with delays', async () => {
    const receiver = await startReceiver();
    receivers.push(receiver);
    const custom = await createScenario(host.db, {
      workspaceId: host.workspace.id,
      gateway: 'sslcommerz',
      name: 'two-step',
      definition: ScenarioDefinitionSchema.parse({
        name: 'two-step',
        steps: [{ action: 'redirect_success' }, { delayMs: 120, action: 'send_ipn_duplicate' }],
      }),
    });
    const txn = await host.seedTxn({ ipnUrl: receiver.url });
    const fresh = await host.stores.getTransaction(txn.id);
    if (!fresh) throw new Error('Missing txn');
    await host.ctx.engine.attach({
      txn: fresh,
      scenarioId: custom.id,
      definition: custom.definition,
      source: 'magic',
    });

    await host.waitFor(async () => receiver.posts.length === 2, 'both IPNs to arrive');
    expect(receiver.posts[0]?.fields['val_id']).toBe(receiver.posts[1]?.fields['val_id']);
    await host.waitFor(
      async () => (await eventTypes(host, txn.id)).includes('scenario.ended'),
      'scenario to end',
    );
  });

  it('settles inline on settle_later and ends on stay_pending', async () => {
    const settle = await createScenario(host.db, {
      workspaceId: host.workspace.id,
      gateway: 'sslcommerz',
      name: 'settle-case',
      definition: ScenarioDefinitionSchema.parse({
        name: 'settle-case',
        steps: [{ delayMs: 20, action: 'settle_later' }],
      }),
    });
    const txn = await host.seedTxn({ ipnUrl: null });
    const fresh = await host.stores.getTransaction(txn.id);
    if (!fresh) throw new Error('Missing txn');
    await host.ctx.engine.attach({
      txn: fresh,
      scenarioId: settle.id,
      definition: settle.definition,
      source: 'magic',
    });
    await host.waitFor(async () => (await txnState(host, txn.id)) === 'valid', 'txn to settle');
    const ended = (await host.queries.getTransactionDetail(txn.id))?.events.find(
      (event) => event.type === 'scenario.ended',
    );
    expect(ended?.data['reason']).toBe('settled');

    const pending = await createScenario(host.db, {
      workspaceId: host.workspace.id,
      gateway: 'sslcommerz',
      name: 'pending-case',
      definition: ScenarioDefinitionSchema.parse({
        name: 'pending-case',
        steps: [{ action: 'stay_pending' }],
      }),
    });
    const txn2 = await host.seedTxn({ ipnUrl: null });
    const fresh2 = await host.stores.getTransaction(txn2.id);
    if (!fresh2) throw new Error('Missing txn');
    await host.ctx.engine.attach({
      txn: fresh2,
      scenarioId: pending.id,
      definition: pending.definition,
      source: 'magic',
    });
    await host.waitFor(
      async () => (await eventTypes(host, txn2.id)).includes('scenario.ended'),
      'stay_pending to end',
    );
    expect(await txnState(host, txn2.id)).toBe('initiated');
  });

  it('drives late-ipn and expiry through the fake clock', async () => {
    const receiver = await startReceiver();
    receivers.push(receiver);
    try {
      const txn = await host.seedTxn({ ipnUrl: receiver.url });
      await attachBuiltin(txn.id, 'late-ipn');
      await host.waitFor(async () => (await txnState(host, txn.id)) === 'valid', 'txn to settle');
      expect(receiver.posts).toHaveLength(0);

      const shifted = await host.jumpClock(31_000);
      expect(shifted).toBeGreaterThan(0);
      await host.waitFor(async () => receiver.posts.length === 1, 'late IPN to arrive');
      expect(receiver.posts[0]?.fields['status']).toBe('VALID');
      await host.resetClock();

      const expiring = await host.seedTxn({ ipnUrl: null });
      await attachBuiltin(expiring.id, 'timeout-expiry');
      await host.jumpClock(61_000);
      await host.waitFor(
        async () => (await txnState(host, expiring.id)) === 'expired',
        'session to expire',
      );
    } finally {
      await host.resetClock();
    }
  });

  it('skips inapplicable steps on terminal transactions without side effects', async () => {
    const receiver = await startReceiver();
    receivers.push(receiver);
    const txn = await host.seedTxn({ ipnUrl: receiver.url, state: 'valid' });
    await attachBuiltin(txn.id, 'immediate-success');
    await host.waitFor(
      async () => (await eventTypes(host, txn.id)).includes('scenario.ended'),
      'scenario to end on a terminal txn',
    );
    expect(receiver.posts).toHaveLength(0);
    expect(await eventTypes(host, txn.id)).toContain(
      'sslcommerz.scenario.redirect_success.skipped',
    );
  });

  it('processes overdue jobs on boot and reclaims interrupted ones', async () => {
    const receiver = await startReceiver();
    receivers.push(receiver);
    const txn = await host.seedTxn({ ipnUrl: receiver.url });
    const resolved = await host.ctx.engine.resolveForInit({
      workspaceId: host.workspace.id,
      gateway: 'sslcommerz',
      defaultScenarioId: null,
      magicName: 'immediate-success',
    });
    // Insert directly (bypassing attach/kick) to simulate a pre-crash queue.
    await host.db.insert(jobs).values({
      workspaceId: host.workspace.id,
      transactionId: txn.id,
      type: 'scenario-step',
      payload: {
        txnId: txn.id,
        scenarioId: resolved.scenarioId,
        scenarioName: resolved.definition.name,
        source: resolved.source,
        stepIndex: 0,
        steps: resolved.definition.steps,
      },
      runAt: new Date(Date.now() - 60_000),
      status: 'running',
    });
    // A fresh Scheduler over the same stack simulates the reboot: its
    // start() reclaims the interrupted job and runs it.
    const fresh = new Scheduler({
      db: host.db,
      ctx: host.ctx,
      logger: host.engineDeps.logger,
      plugins: host.plugins,
      runRetry: (input) => runScheduledRetry(host.deliverDeps, input),
    });
    await fresh.start();
    fresh.stop();
    await host.waitFor(async () => (await txnState(host, txn.id)) === 'valid', 'boot to settle');
    expect(receiver.posts).toHaveLength(1);
  });

  it('retries failed deliveries with backoff, then gives up loudly', async () => {
    const txn = await host.seedTxn({ ipnUrl: 'http://127.0.0.1:1/dead' });
    await attachBuiltin(txn.id, 'immediate-success');
    await host.waitFor(
      async () => (await host.stores.listDeliveries(txn.id)).length === 1,
      'first attempt to record',
    );
    expect(host.scheduledRetries.at(-1)).toMatchObject({ attempt: 2 });
    let deliveries = await host.stores.listDeliveries(txn.id);
    expect(deliveries[0]?.status).toBe('failed');

    // Fast-forward the backoff instead of sleeping through it.
    for (let attempt = 2; attempt <= 6; attempt += 1) {
      await host.db
        .update(jobs)
        .set({ runAt: new Date(Date.now() - 1000) })
        .where(and(eq(jobs.transactionId, txn.id), eq(jobs.status, 'pending')));
      await host.scheduler.runDueNow();
      await host.waitFor(
        async () => (await host.stores.listDeliveries(txn.id)).length === attempt,
        `attempt ${attempt} to record`,
      );
    }
    deliveries = await host.stores.listDeliveries(txn.id);
    expect(deliveries.map((delivery) => delivery.attemptNo)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await eventTypes(host, txn.id)).toContain('callback.dead');
    expect(await pendingJobs(host, txn.id)).not.toContain('delivery-retry');
  });

  it('expires past-due sessions via the expiry job', async () => {
    const txn = await host.seedTxn({ ipnUrl: null, expiresAt: new Date(Date.now() - 1000) });
    await attachBuiltin(txn.id, 'manual');
    await host.waitFor(
      async () => (await txnState(host, txn.id)) === 'expired',
      'past-due session to expire',
    );
  });

  it('fails corrupt jobs loudly with a job.failed event', async () => {
    const txn = await host.seedTxn({ ipnUrl: null });
    await host.db.insert(jobs).values({
      workspaceId: host.workspace.id,
      transactionId: txn.id,
      type: 'scenario-step',
      payload: { nope: true },
      runAt: new Date(Date.now() - 1000),
    });
    await host.db.insert(jobs).values({
      workspaceId: host.workspace.id,
      transactionId: txn.id,
      type: 'bogus-type',
      payload: {},
      runAt: new Date(Date.now() - 1000),
    });
    await host.scheduler.runDueNow();
    const types = await eventTypes(host, txn.id);
    expect(types.filter((type) => type === 'job.failed')).toHaveLength(2);
    const rows = await host.db
      .select({ status: jobs.status })
      .from(jobs)
      .where(eq(jobs.transactionId, txn.id));
    expect(rows.every((row) => row.status === 'failed')).toBe(true);
  });

  it('overrides and detaches scenarios, refusing terminal txns', async () => {
    const custom = await createScenario(host.db, {
      workspaceId: host.workspace.id,
      gateway: 'sslcommerz',
      name: 'override-target',
      definition: ScenarioDefinitionSchema.parse({
        name: 'override-target',
        steps: [{ delayMs: 60_000, action: 'redirect_success' }],
      }),
    });
    const txn = await host.seedTxn({ ipnUrl: null });
    await attachBuiltin(txn.id, 'pending-then-settled');

    const ops = {
      db: host.db,
      engineDeps: host.engineDeps,
      applyDeps: host.applyDeps,
      storage: { get: async () => new Uint8Array() } as never,
      deliver: host.ctx.deliverCallback,
    };
    const overridden = await applyTxnScenario(ops, txn.id, custom.id);
    expect(overridden.scenarioOverrideId).toBe(custom.id);
    // The old pending-then-settled step was cancelled; only the new step
    // plus the pre-existing expiry timer remain.
    expect(await pendingJobs(host, txn.id)).toHaveLength(2);

    const detached = await applyTxnScenario(ops, txn.id, null);
    expect(detached.scenarioOverrideId).toBeNull();
    expect(await eventTypes(host, txn.id)).toContain('scenario.detached');

    const done = await host.seedTxn({ ipnUrl: null, state: 'valid' });
    await expect(applyTxnScenario(ops, done.id, custom.id)).rejects.toBeInstanceOf(
      TerminalOverrideError,
    );
  });

  it('replays recorded callbacks as fresh attempts', async () => {
    const receiver = await startReceiver();
    receivers.push(receiver);
    const txn = await host.seedTxn({ ipnUrl: receiver.url });
    await attachBuiltin(txn.id, 'immediate-success');
    await host.waitFor(async () => (await txnState(host, txn.id)) === 'valid', 'txn to settle');
    await host.waitFor(async () => receiver.posts.length === 1, 'original IPN to arrive');

    const ops = {
      db: host.db,
      engineDeps: host.engineDeps,
      applyDeps: host.applyDeps,
      storage: { get: async () => new Uint8Array() } as never,
      deliver: host.ctx.deliverCallback,
    };
    const replayed = await replayDelivery(ops, txn.id);
    expect(replayed.attemptNo).toBe(2);
    expect(replayed.status).toBe('delivered');
    expect(receiver.posts).toHaveLength(2);
    expect(receiver.posts[1]?.fields['tran_id']).toBe(txn.gatewayTxnId);
    expect(await eventTypes(host, txn.id)).toContain('callback.replayed');

    await expect(
      replayDelivery(ops, txn.id, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toBeInstanceOf(DeliveryNotFoundError);
  });
});
