// Shared checkout completion: the mock-page buttons AND scenario
// actions (redirect_*) funnel through here. Records the callback URL the
// customer browser would follow; the community flow performs NO
// server-to-server callback, so nothing is POSTed.

import type { PluginContext, TxnRecord } from '@paysim/core';

import { buildCallbackUrl, generateSimTrxId } from './builders.js';
import { applyCheckoutAction, callbackKindFor, type CheckoutAction } from './state-machine.js';
import { asString } from './util.js';

export interface CompleteCheckoutInput {
  ctx: PluginContext;
  txn: TxnRecord;
  outcome: CheckoutAction;
  /** Real-sandbox mode: Nagad's issuer reference replaces the sim trxId. */
  providerTrxId?: string;
}

export interface CompleteCheckoutResult {
  txn: TxnRecord;
  status: 'Success' | 'Fail' | 'Cancel';
  targetUrl: string;
}

export async function completeCheckout(
  input: CompleteCheckoutInput,
): Promise<CompleteCheckoutResult> {
  const { ctx, txn, outcome } = input;
  const target = applyCheckoutAction('checkout', outcome);
  const kind = callbackKindFor(outcome);
  const status = kind === 'success' ? 'Success' : kind === 'fail' ? 'Fail' : 'Cancel';
  const metadataPatch: Record<string, unknown> =
    status === 'Success' ? { trxId: input.providerTrxId || generateSimTrxId() } : {};
  const updated = await ctx.stores.transitionTransaction(
    txn.id,
    target,
    `nagad.checkout.${outcome}`,
    { paymentRefId: txn.gatewaySessionKey, status },
    metadataPatch,
  );
  const targetUrl = buildCallbackUrl(asString(txn.metadata['merchantCallbackURL']), {
    merchant: asString(txn.metadata['merchantId']),
    orderId: asString(txn.metadata['orderId']),
    paymentRefId: txn.gatewaySessionKey ?? '',
    status,
  });
  await ctx.stores.recordEvent({
    workspaceId: txn.workspaceId,
    transactionId: txn.id,
    type: 'nagad.callback.ready',
    data: { status, targetUrl, method: 'GET', note: 'customer-browser redirect; no server POST' },
  });
  return { txn: updated, status, targetUrl };
}
