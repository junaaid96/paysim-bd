// Scenario-action implementations for Rocket. Tolerant by contract.
// Checkout has no server-to-server callback, so the send_ipn* family
// records a skipped step explaining where the result comes from.

import type { AppRecord, PluginContext, TxnRecord } from '@paysim/core';

import { completeCheckout } from './checkout.js';
import { isTerminal, type CheckoutAction, type RocketState } from './state-machine.js';

function outcomeFor(action: string): CheckoutAction {
  if (action === 'redirect_success') return 'success';
  if (action === 'redirect_fail') return 'fail';
  return 'cancel';
}

async function recordSkipped(
  ctx: PluginContext,
  txn: TxnRecord,
  action: string,
  reason: string,
): Promise<void> {
  await ctx.stores.recordEvent({
    workspaceId: txn.workspaceId,
    transactionId: txn.id,
    type: `rocket.scenario.${action}.skipped`,
    data: { reason, status: txn.state },
  });
}

export async function runScenarioAction(
  ctx: PluginContext,
  txn: TxnRecord,
  _app: AppRecord,
  action: string,
  params: Record<string, unknown>,
): Promise<void> {
  void _app;
  switch (action) {
    case 'redirect_success':
    case 'redirect_fail':
    case 'redirect_cancel': {
      if (isTerminal(txn.state as RocketState)) {
        await recordSkipped(ctx, txn, action, 'transaction terminal');
        return;
      }
      if (txn.state !== 'checkout') {
        await recordSkipped(ctx, txn, action, 'session not open');
        return;
      }
      await completeCheckout({ ctx, txn, outcome: outcomeFor(action) });
      return;
    }
    case 'send_ipn':
    case 'send_ipn_duplicate':
    case 'send_ipn_late': {
      await recordSkipped(
        ctx,
        txn,
        action,
        'DBBL documents no server IPN; the customer browser returns trans_id to the merchant URL',
      );
      return;
    }
    case 'mutate_amount': {
      const delta = params['deltaMinor'];
      if (typeof delta !== 'number' || !Number.isInteger(delta)) {
        throw new Error('mutate_amount requires params.deltaMinor (integer minor units)');
      }
      await ctx.stores.setTransactionAmount(txn.id, txn.amountMinor + delta, {
        scenarioMutated: true,
      });
      await ctx.stores.recordEvent({
        workspaceId: txn.workspaceId,
        transactionId: txn.id,
        type: 'rocket.scenario.mutate_amount',
        data: { deltaMinor: delta, amountMinor: txn.amountMinor + delta },
      });
      return;
    }
    case 'stay_pending': {
      await ctx.stores.recordEvent({
        workspaceId: txn.workspaceId,
        transactionId: txn.id,
        type: 'rocket.scenario.stay_pending',
        data: { status: txn.state },
      });
      return;
    }
    case 'timeout': {
      const state = txn.state as RocketState;
      if (state !== 'initiated' && state !== 'checkout') {
        await recordSkipped(ctx, txn, action, 'transaction terminal');
        return;
      }
      await ctx.stores.transitionTransaction(txn.id, 'expired', 'rocket.scenario.timeout', {
        trans_id: txn.gatewaySessionKey,
      });
      return;
    }
    default:
      throw new Error(`Unsupported action for ${txn.gateway}: ${action}`);
  }
}
