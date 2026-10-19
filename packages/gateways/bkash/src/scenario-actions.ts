// Scenario-action implementations for bKash. Tolerant by contract.
// Tokenized checkout has no server-to-server callback, so the send_ipn*
// family records a skipped step explaining where the paymentID goes.

import type { AppRecord, PluginContext, TxnRecord } from '@paysim/core';

import { formatBkashDatetime } from './builders.js';
import { completeVerification } from './checkout.js';
import { isTerminal, type BkashState, type CheckoutAction } from './state-machine.js';

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
    type: `bkash.scenario.${action}.skipped`,
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
      if (isTerminal(txn.state as BkashState)) {
        await recordSkipped(ctx, txn, action, 'transaction terminal');
        return;
      }
      await completeVerification({ ctx, txn, outcome: outcomeFor(action) });
      return;
    }
    case 'send_ipn':
    case 'send_ipn_duplicate':
    case 'send_ipn_late': {
      await recordSkipped(
        ctx,
        txn,
        action,
        'tokenized checkout has no server callback; the customer browser carries paymentID+status to the callback URL',
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
        type: 'bkash.scenario.mutate_amount',
        data: { deltaMinor: delta, amountMinor: txn.amountMinor + delta },
      });
      return;
    }
    case 'stay_pending': {
      await ctx.stores.recordEvent({
        workspaceId: txn.workspaceId,
        transactionId: txn.id,
        type: 'bkash.scenario.stay_pending',
        data: { status: txn.state },
      });
      return;
    }
    case 'timeout': {
      const state = txn.state as BkashState;
      if (state !== 'initiated' && state !== 'verified') {
        await recordSkipped(ctx, txn, action, 'transaction terminal');
        return;
      }
      await ctx.stores.transitionTransaction(
        txn.id,
        'expired',
        'bkash.scenario.timeout',
        { paymentId: txn.gatewaySessionKey },
        { paymentUpdateTime: formatBkashDatetime(ctx.clock.now(txn.workspaceId)) },
      );
      return;
    }
    default:
      throw new Error(`Unsupported action for ${txn.gateway}: ${action}`);
  }
}
