import { beforeEach, describe, expect, it } from 'vitest';

import { ScenarioDefinitionSchema, type AppRecord, type TxnRecord } from '@paysim/core';

import { bkashPlugin } from '../src/index.js';
import { runScenarioAction } from '../src/scenario-actions.js';
import { BUILTIN_SCENARIOS } from '../src/scenarios.js';
import { makeCtx, type FakeContext, type FakeStores } from './fakes.js';

async function seedTxn(stores: FakeStores, metadataOverrides: Record<string, unknown> = {}) {
  const app = stores.apps[0] ?? stores.seedApp();
  const txn = await stores.createTransaction({
    workspaceId: app.workspaceId,
    gatewayAppId: app.id,
    gateway: 'bkash',
    state: 'initiated',
    gatewaySessionKey: 'TR0011TEST0123456789012',
    amountMinor: 15075,
    currency: 'BDT',
    metadata: {
      payerReference: 'TEST001ABC',
      callbackURL: 'https://merchant.test/cb',
      merchantInvoiceNumber: 'INV-1',
      subMerchantName: '',
      merchantAssociationInfo: '',
      intent: 'sale',
      signature: 'sig1234567',
      callbackUrls: {
        success: 'https://merchant.test/cb?paymentID=X&status=success&signature=sig1234567',
        failure: 'https://merchant.test/cb?paymentID=X&status=failure&signature=sig1234567',
        cancelled: 'https://merchant.test/cb?paymentID=X&status=cancel&signature=sig1234567',
      },
      paymentCreateTime: '2026-01-01T00:00:00:000 GMT+0600',
      paymentUpdateTime: '2026-01-01T00:00:00:000 GMT+0600',
      ...metadataOverrides,
    },
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return { app, txn };
}

describe('bkash runScenarioAction', () => {
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

  it('redirect_success verifies and records the callback URL (no server POST)', async () => {
    await runScenarioAction(fakes.ctx, txn, app, 'redirect_success', {});
    expect(txn.state).toBe('verified');
    expect(fakes.delivered).toHaveLength(0);
    expect(eventTypes()).toContain('bkash.checkout.success');
    const ready = fakes.stores.events.find((event) => event.type === 'bkash.callback.ready');
    expect(ready?.data).toMatchObject({ kind: 'success', method: 'GET' });
  });

  it('redirect_fail and redirect_cancel drive failed and cancelled', async () => {
    await runScenarioAction(fakes.ctx, txn, app, 'redirect_fail', {});
    expect(txn.state).toBe('failed');

    const second = await seedTxn(fakes.stores);
    await runScenarioAction(fakes.ctx, second.txn, second.app, 'redirect_cancel', {});
    expect(second.txn.state).toBe('cancelled');
  });

  it('redirect on a terminal transaction skips tolerantly', async () => {
    await runScenarioAction(fakes.ctx, txn, app, 'redirect_success', {});
    await runScenarioAction(fakes.ctx, txn, app, 'redirect_fail', {});
    // verified is non-terminal for scenarios, so the fail still applies.
    expect(txn.state).toBe('failed');
    await runScenarioAction(fakes.ctx, txn, app, 'redirect_success', {});
    expect(txn.state).toBe('failed');
    expect(eventTypes()).toContain('bkash.scenario.redirect_success.skipped');
  });

  it('send_ipn actions skip with the no-server-callback reason', async () => {
    await runScenarioAction(fakes.ctx, txn, app, 'redirect_success', {});
    await runScenarioAction(fakes.ctx, txn, app, 'send_ipn_duplicate', {});
    expect(fakes.delivered).toHaveLength(0);
    const skipped = fakes.stores.events.find(
      (event) => event.type === 'bkash.scenario.send_ipn_duplicate.skipped',
    );
    expect(String(skipped?.data['reason'] ?? '')).toContain('no server callback');
  });

  it('mutate_amount adjusts the amount and records an event', async () => {
    await runScenarioAction(fakes.ctx, txn, app, 'mutate_amount', { deltaMinor: 100 });
    expect(txn.amountMinor).toBe(15175);
    expect(eventTypes()).toContain('bkash.scenario.mutate_amount');
    await expect(runScenarioAction(fakes.ctx, txn, app, 'mutate_amount', {})).rejects.toThrow(
      /deltaMinor/,
    );
  });

  it('stay_pending only records an event', async () => {
    await runScenarioAction(fakes.ctx, txn, app, 'stay_pending', {});
    expect(txn.state).toBe('initiated');
    expect(eventTypes()).toContain('bkash.scenario.stay_pending');
  });

  it('timeout expires initiated and verified payments, skips terminal ones', async () => {
    await runScenarioAction(fakes.ctx, txn, app, 'timeout', {});
    expect(txn.state).toBe('expired');

    const second = await seedTxn(fakes.stores);
    await runScenarioAction(fakes.ctx, second.txn, second.app, 'redirect_success', {});
    await runScenarioAction(fakes.ctx, second.txn, second.app, 'timeout', {});
    expect(second.txn.state).toBe('expired');

    await runScenarioAction(fakes.ctx, second.txn, second.app, 'timeout', {});
    expect(eventTypes()).toContain('bkash.scenario.timeout.skipped');
  });

  it('unknown actions throw', async () => {
    await expect(runScenarioAction(fakes.ctx, txn, app, 'settle_later', {})).rejects.toThrow(
      /Unsupported action/,
    );
  });
});

describe('bkash built-in scenarios', () => {
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
    expect(names).toContain('verify-then-expire');
  });

  it('exposes terminal states through the plugin contract', () => {
    expect(bkashPlugin.isTerminalState('initiated')).toBe(false);
    expect(bkashPlugin.isTerminalState('verified')).toBe(false);
    for (const state of ['completed', 'failed', 'cancelled', 'expired']) {
      expect(bkashPlugin.isTerminalState(state)).toBe(true);
    }
  });
});
