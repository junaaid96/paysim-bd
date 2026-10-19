// Scenario-action implementations for SSLCommerz. Invoked by the API
// scheduler. Tolerant by contract: unmet preconditions record a skipped
// step and return; only authoring errors in params throw.

import { type AppRecord, formatDbDatetime, type PluginContext, type TxnRecord } from '@paysim/core';

import { DEFAULT_CARD_FIXTURE, buildIpnPayload, generateRefId } from './builders.js';
import { type CheckoutOutcome, completeCheckout } from './checkout.js';
import {
  InvalidTransitionError,
  ipnStatusFor,
  isTerminal,
  type SslcommerzState,
} from './state-machine.js';
import { asString, stringifyEchoes } from './util.js';

function outcomeFor(action: string): CheckoutOutcome {
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
    type: `sslcommerz.scenario.${action}.skipped`,
    data: { reason, status: txn.state },
  });
}

/** Rebuild the IPN payload at current clock time (docs-only shape, like init). */
async function sendIpnNow(
  ctx: PluginContext,
  txn: TxnRecord,
  app: AppRecord,
  action: string,
): Promise<void> {
  const ipnUrl = asString(txn.metadata['ipnUrl']);
  if (!ipnUrl || !txn.gatewayTxnId) {
    await recordSkipped(
      ctx,
      txn,
      action,
      !ipnUrl ? 'no ipn_url on init' : 'missing gateway_txn_id',
    );
    return;
  }
  let ipnStatus;
  try {
    ipnStatus = ipnStatusFor(txn.state as SslcommerzState);
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      await recordSkipped(ctx, txn, action, `no payment event for state ${txn.state}`);
      return;
    }
    throw err;
  }
  const storePasswd = asString(app.credentials['store_passwd']);
  const tranDate = formatDbDatetime(ctx.clock.now(txn.workspaceId));
  await ctx.stores.recordEvent({
    workspaceId: txn.workspaceId,
    transactionId: txn.id,
    type: `sslcommerz.scenario.${action}`,
    data: { statusAtSend: txn.state },
  });
  await ctx.deliverCallback({
    txn,
    kind: 'ipn',
    targetUrl: ipnUrl,
    payload: buildIpnPayload({
      ipnStatus,
      tranId: txn.gatewayTxnId,
      valId: asString(txn.metadata['valId']),
      amountMinor: txn.amountMinor,
      currencyType: asString(txn.metadata['currencyType'], txn.currency),
      storeId: asString(app.credentials['store_id']),
      storePasswd,
      bankTranId: asString(txn.metadata['bankTranId']),
      tranDate,
      card: DEFAULT_CARD_FIXTURE,
      values: {
        a: asString(txn.metadata['valueA']),
        b: asString(txn.metadata['valueB']),
        c: asString(txn.metadata['valueC']),
        d: asString(txn.metadata['valueD']),
      },
      echoes: {
        ...stringifyEchoes(txn.customer),
        ...stringifyEchoes((txn.metadata['ship'] ?? {}) as Record<string, unknown>),
      },
    }),
  });
}

export async function runScenarioAction(
  ctx: PluginContext,
  txn: TxnRecord,
  app: AppRecord,
  action: string,
  params: Record<string, unknown>,
): Promise<void> {
  switch (action) {
    case 'redirect_success':
    case 'redirect_fail':
    case 'redirect_cancel': {
      if (isTerminal(txn.state as SslcommerzState)) {
        await recordSkipped(ctx, txn, action, 'transaction terminal');
        return;
      }
      await completeCheckout({
        ctx,
        txn,
        app,
        outcome: outcomeFor(action),
        skipIpn: params['skipIpn'] === true,
      });
      return;
    }
    case 'send_ipn':
    case 'send_ipn_duplicate':
    case 'send_ipn_late': {
      await sendIpnNow(ctx, txn, app, action);
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
        type: 'sslcommerz.scenario.mutate_amount',
        data: { deltaMinor: delta, amountMinor: txn.amountMinor + delta },
      });
      return;
    }
    case 'stay_pending': {
      await ctx.stores.recordEvent({
        workspaceId: txn.workspaceId,
        transactionId: txn.id,
        type: 'sslcommerz.scenario.stay_pending',
        data: { status: txn.state },
      });
      return;
    }
    case 'timeout': {
      if (isTerminal(txn.state as SslcommerzState)) {
        await recordSkipped(ctx, txn, action, 'transaction terminal');
        return;
      }
      await ctx.stores.transitionTransaction(
        txn.id,
        'expired',
        'sslcommerz.scenario.timeout',
        { sessionkey: txn.gatewaySessionKey },
        { bankTranId: generateRefId() },
      );
      return;
    }
    default:
      throw new Error(`Unsupported action for ${txn.gateway}: ${action}`);
  }
}
