import { beforeEach, describe, expect, it } from 'vitest';

import { ScenarioDefinitionSchema, type AppRecord, type TxnRecord } from '@paysim/core';

import { nagadPlugin } from '../src/index.js';
import { runScenarioAction } from '../src/scenario-actions.js';
import { BUILTIN_SCENARIOS } from '../src/scenarios.js';
import { makeCtx, type FakeContext, type FakeStores } from './fakes.js';

async function seedTxn(stores: FakeStores, state = 'checkout') {
  const app = stores.apps[0] ?? stores.seedApp();
  const txn = await stores.createTransaction({
    workspaceId: app.workspaceId,
    gatewayAppId: app.id,
    gateway: 'nagad',
    state,
    gatewayTxnId: 'SIM-MERCHANT-001:ORDER-1',
    gatewaySessionKey: 'SIMREF0000000000000001',
    amountMinor: 10000,
    currency: 'BDT',
    metadata: {
      merchantId: 'SIM-MERCHANT-001',
      orderId: 'ORDER-1',
      merchantCallbackURL: 'https://merchant.test/cb',
      additionalMerchantInfo: {},
      amountKnown: true,
    },
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return { app, txn };
}

describe('nagad runScenarioAction', () => {
  let fakes: FakeContext;
  let app: AppRecord;
  let txn: TxnRecord;

  beforeEach(async () => {
    fakes = makeCtx();
    const seeded = await seedTxn(fakes.stores);
    app = seeded.app;
    txn = seeded.txn;
  });

  function eventTypes(): string[] {
    return fakes.stores.events.map((event) => event.type);
  }

  it('redirect_success settles checkout and records the callback URL (no server POST)', async () => {
    await runScenarioAction(fakes.ctx, txn, app, 'redirect_success', {});
    expect(txn.state).toBe('success');
    expect(fakes.delivered).toHaveLength(0);
    expect(eventTypes()).toContain('nagad.checkout.success');
    const ready = fakes.stores.events.find((event) => event.type === 'nagad.callback.ready');
    expect(ready?.data).toMatchObject({ status: 'Success', method: 'GET' });
    expect(txn.metadata['trxId']).toMatch(/^SIMTRX[0-9A-F]{10}$/);
  });

  it('redirect on initiated skips until the merchant calls complete', async () => {
    const early = await seedTxn(fakes.stores, 'initiated');
    await runScenarioAction(fakes.ctx, early.txn, early.app, 'redirect_success', {});
    expect(early.txn.state).toBe('initiated');
    expect(eventTypes()).toContain('nagad.scenario.redirect_success.skipped');
  });

  it('redirect on terminal transactions skips tolerantly', async () => {
    await runScenarioAction(fakes.ctx, txn, app, 'redirect_fail', {});
    expect(txn.state).toBe('failed');
    await runScenarioAction(fakes.ctx, txn, app, 'redirect_success', {});
    expect(txn.state).toBe('failed');
    expect(eventTypes()).toContain('nagad.scenario.redirect_success.skipped');
  });

  it('send_ipn actions skip with the no-server-callback reason', async () => {
    await runScenarioAction(fakes.ctx, txn, app, 'send_ipn_duplicate', {});
    expect(fakes.delivered).toHaveLength(0);
    const skipped = fakes.stores.events.find(
      (event) => event.type === 'nagad.scenario.send_ipn_duplicate.skipped',
    );
    expect(String(skipped?.data['reason'] ?? '')).toContain('no server callback');
  });

  it('mutate_amount adjusts the amount and records an event', async () => {
    await runScenarioAction(fakes.ctx, txn, app, 'mutate_amount', { deltaMinor: 100 });
    expect(txn.amountMinor).toBe(10100);
    expect(eventTypes()).toContain('nagad.scenario.mutate_amount');
    await expect(runScenarioAction(fakes.ctx, txn, app, 'mutate_amount', {})).rejects.toThrow(
      /deltaMinor/,
    );
  });

  it('stay_pending only records an event', async () => {
    await runScenarioAction(fakes.ctx, txn, app, 'stay_pending', {});
    expect(txn.state).toBe('checkout');
    expect(eventTypes()).toContain('nagad.scenario.stay_pending');
  });

  it('timeout expires initiated and checkout payments, skips terminal ones', async () => {
    await runScenarioAction(fakes.ctx, txn, app, 'timeout', {});
    expect(txn.state).toBe('expired');

    const early = await seedTxn(fakes.stores, 'initiated');
    await runScenarioAction(fakes.ctx, early.txn, early.app, 'timeout', {});
    expect(early.txn.state).toBe('expired');

    await runScenarioAction(fakes.ctx, early.txn, early.app, 'timeout', {});
    expect(eventTypes()).toContain('nagad.scenario.timeout.skipped');
  });

  it('unknown actions throw', async () => {
    await expect(runScenarioAction(fakes.ctx, txn, app, 'settle_later', {})).rejects.toThrow(
      /Unsupported action/,
    );
  });
});

describe('nagad built-in scenarios', () => {
  it('all validate, carry unique names and skip IPN presets', () => {
    const names = new Set<string>();
    for (const builtin of BUILTIN_SCENARIOS) {
      const parsed = ScenarioDefinitionSchema.parse(builtin);
      expect(names.has(parsed.name)).toBe(false);
      names.add(parsed.name);
      for (const step of parsed.steps) {
        expect(step.action.startsWith('send_ipn')).toBe(false);
      }
    }
    expect(names).toContain('manual');
    expect(names).toContain('immediate-success');
    expect(names).toContain('pending-then-success');
  });

  it('exposes terminal states through the plugin contract', () => {
    expect(nagadPlugin.isTerminalState('initiated')).toBe(false);
    expect(nagadPlugin.isTerminalState('checkout')).toBe(false);
    for (const state of ['success', 'failed', 'cancelled', 'expired']) {
      expect(nagadPlugin.isTerminalState(state)).toBe(true);
    }
  });
});
