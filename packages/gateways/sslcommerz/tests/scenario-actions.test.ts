import { beforeEach, describe, expect, it } from 'vitest';

import { ScenarioDefinitionSchema, type AppRecord, type TxnRecord } from '@paysim/core';

import { sslcommerzPlugin } from '../src/index.js';
import { runScenarioAction } from '../src/scenario-actions.js';
import { BUILTIN_SCENARIOS } from '../src/scenarios.js';
import { verifySignature } from '../src/verify.js';
import { makeCtx, type FakeContext, type FakeStores } from './fakes.js';

async function seedTxn(stores: FakeStores, metadataOverrides: Record<string, unknown> = {}) {
  const app = stores.apps[0] ?? stores.seedApp();
  const txn = await stores.createTransaction({
    workspaceId: app.workspaceId,
    gatewayAppId: app.id,
    gateway: 'sslcommerz',
    state: 'initiated',
    gatewayTxnId: 'ORDER-1',
    gatewaySessionKey: 'SESS1',
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
      ipnUrl: 'http://client.test/pay/ipn',
      valueA: 'ref001',
      valueB: '',
      valueC: '',
      valueD: '',
      ship: {},
      ...metadataOverrides,
    },
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return { app, txn };
}

describe('runScenarioAction', () => {
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

  function expectSignedIpn(index: number, status: string): void {
    const ipn = fakes.delivered[index];
    expect(ipn?.targetUrl).toBe('http://client.test/pay/ipn');
    expect(ipn?.payload['status']).toBe(status);
    expect(ipn?.payload['tran_id']).toBe('ORDER-1');
    expect(
      verifySignature(
        ipn?.payload ?? {},
        ipn?.payload['verify_key'] ?? '',
        'qwerty',
        ipn?.payload['verify_sign'] ?? '',
      ),
    ).toBe(true);
  }

  it('redirect_success completes and sends a signed VALID IPN', async () => {
    await runScenarioAction(fakes.ctx, txn, app, 'redirect_success', {});
    expect(txn.state).toBe('valid');
    expect(fakes.delivered).toHaveLength(1);
    expectSignedIpn(0, 'VALID');
    expect(eventTypes()).toContain('sslcommerz.checkout.success');
  });

  it('redirect_success with skipIpn completes silently (late-ipn first step)', async () => {
    await runScenarioAction(fakes.ctx, txn, app, 'redirect_success', { skipIpn: true });
    expect(txn.state).toBe('valid');
    expect(fakes.delivered).toHaveLength(0);
  });

  it('redirect_fail and redirect_cancel drive FAILED and CANCELLED IPNs', async () => {
    await runScenarioAction(fakes.ctx, txn, app, 'redirect_fail', {});
    expect(txn.state).toBe('failed');
    expectSignedIpn(0, 'FAILED');

    const second = await seedTxn(fakes.stores);
    await runScenarioAction(fakes.ctx, second.txn, second.app, 'redirect_cancel', {});
    expect(second.txn.state).toBe('cancelled');
    expectSignedIpn(1, 'CANCELLED');
  });

  it('redirect on a terminal transaction skips tolerantly', async () => {
    await runScenarioAction(fakes.ctx, txn, app, 'redirect_success', {});
    expect(fakes.delivered).toHaveLength(1);
    await runScenarioAction(fakes.ctx, txn, app, 'redirect_fail', {});
    expect(txn.state).toBe('valid');
    expect(fakes.delivered).toHaveLength(1);
    expect(eventTypes()).toContain('sslcommerz.scenario.redirect_fail.skipped');
  });

  it('send_ipn_duplicate replays the identical IPN', async () => {
    await runScenarioAction(fakes.ctx, txn, app, 'redirect_success', {});
    await runScenarioAction(fakes.ctx, txn, app, 'send_ipn_duplicate', {});
    expect(fakes.delivered).toHaveLength(2);
    const [first, second] = fakes.delivered;
    expect(second?.targetUrl).toBe(first?.targetUrl);
    expect(second?.payload['tran_id']).toBe('ORDER-1');
    expect(second?.payload['val_id']).toBe(first?.payload['val_id']);
    expect(second?.payload['status']).toBe('VALID');
    expect(
      verifySignature(
        second?.payload ?? {},
        second?.payload['verify_key'] ?? '',
        'qwerty',
        second?.payload['verify_sign'] ?? '',
      ),
    ).toBe(true);
  });

  it('send_ipn on an open transaction skips (no payment event yet)', async () => {
    await runScenarioAction(fakes.ctx, txn, app, 'send_ipn', {});
    expect(fakes.delivered).toHaveLength(0);
    expect(eventTypes()).toContain('sslcommerz.scenario.send_ipn.skipped');
  });

  it('send_ipn without ipn_url skips', async () => {
    const seeded = await seedTxn(fakes.stores, { ipnUrl: null });
    await runScenarioAction(fakes.ctx, seeded.txn, seeded.app, 'redirect_success', {});
    await runScenarioAction(fakes.ctx, seeded.txn, seeded.app, 'send_ipn_late', {});
    expect(fakes.delivered).toHaveLength(0);
    expect(eventTypes()).toContain('sslcommerz.scenario.send_ipn_late.skipped');
  });

  it('mutate_amount adjusts the amount and records an event', async () => {
    await runScenarioAction(fakes.ctx, txn, app, 'mutate_amount', { deltaMinor: 100 });
    expect(txn.amountMinor).toBe(10400);
    expect(txn.metadata['scenarioMutated']).toBe(true);
    expect(eventTypes()).toContain('sslcommerz.scenario.mutate_amount');
  });

  it('mutate_amount without an integer delta throws (authoring error)', async () => {
    await expect(runScenarioAction(fakes.ctx, txn, app, 'mutate_amount', {})).rejects.toThrow(
      /deltaMinor/,
    );
    await expect(
      runScenarioAction(fakes.ctx, txn, app, 'mutate_amount', { deltaMinor: 1.5 }),
    ).rejects.toThrow(/deltaMinor/);
  });

  it('stay_pending only records an event', async () => {
    await runScenarioAction(fakes.ctx, txn, app, 'stay_pending', {});
    expect(txn.state).toBe('initiated');
    expect(fakes.delivered).toHaveLength(0);
    expect(eventTypes()).toContain('sslcommerz.scenario.stay_pending');
  });

  it('timeout expires open sessions and skips terminal ones', async () => {
    await runScenarioAction(fakes.ctx, txn, app, 'timeout', {});
    expect(txn.state).toBe('expired');
    expect(eventTypes()).toContain('sslcommerz.scenario.timeout');

    await runScenarioAction(fakes.ctx, txn, app, 'timeout', {});
    expect(eventTypes()).toContain('sslcommerz.scenario.timeout.skipped');
  });

  it('unknown actions throw', async () => {
    await expect(runScenarioAction(fakes.ctx, txn, app, 'settle_later', {})).rejects.toThrow(
      /Unsupported action/,
    );
    await expect(runScenarioAction(fakes.ctx, txn, app, 'nope', {})).rejects.toThrow(
      /Unsupported action/,
    );
  });
});

describe('sslcommerz built-in scenarios', () => {
  it('all validate and carry unique names', () => {
    const names = new Set<string>();
    for (const builtin of BUILTIN_SCENARIOS) {
      const parsed = ScenarioDefinitionSchema.parse(builtin);
      expect(names.has(parsed.name)).toBe(false);
      names.add(parsed.name);
    }
    expect(names).toContain('manual');
    expect(names).toContain('duplicate-ipn');
    expect(names).toContain('late-ipn');
  });

  it('late-ipn suppresses the immediate IPN; amount-mismatch carries a delta', () => {
    const late = ScenarioDefinitionSchema.parse(
      BUILTIN_SCENARIOS.find((scenario) => scenario.name === 'late-ipn'),
    );
    expect(late.steps[0]).toMatchObject({ action: 'redirect_success', params: { skipIpn: true } });
    expect(late.steps[1]?.action).toBe('send_ipn_late');

    const mismatch = ScenarioDefinitionSchema.parse(
      BUILTIN_SCENARIOS.find((scenario) => scenario.name === 'amount-mismatch'),
    );
    expect(mismatch.steps[0]?.action).toBe('mutate_amount');
    expect(typeof mismatch.steps[0]?.params['deltaMinor']).toBe('number');
  });

  it('exposes terminal states through the plugin contract', () => {
    expect(sslcommerzPlugin.isTerminalState('initiated')).toBe(false);
    for (const state of ['valid', 'failed', 'cancelled', 'expired']) {
      expect(sslcommerzPlugin.isTerminalState(state)).toBe(true);
    }
  });
});
