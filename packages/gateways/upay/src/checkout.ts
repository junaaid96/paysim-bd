// Shared checkout completion for the mock page buttons, scenario actions
// and the real-sandbox return. Upay documents no server-to-server IPN:
// the customer browser carries status + invoice_id back to redirect_url,
// and the merchant must confirm with single-payment-status.

import type { PluginContext, TxnRecord } from '@paysim/core';

import { buildRedirectUrl, simId } from './builders.js';
import { applyCheckoutAction, type CheckoutAction } from './state-machine.js';
import { asString } from './util.js';

export interface CompleteCheckoutInput {
  ctx: PluginContext;
  txn: TxnRecord;
  outcome: CheckoutAction;
  providerTrxId?: string;
  wallet?: string;
}

export const REDIRECT_STATUS: Record<CheckoutAction, string> = {
  success: 'success',
  fail: 'failed',
  cancel: 'cancelled',
};

export async function completeCheckout(
  input: CompleteCheckoutInput,
): Promise<{ txn: TxnRecord; status: string; targetUrl: string }> {
  const { ctx, txn, outcome } = input;
  const target = applyCheckoutAction('checkout', outcome);
  const status = REDIRECT_STATUS[outcome];
  const patch: Record<string, unknown> = {};
  if (outcome === 'success')
    patch['trxId'] = input.providerTrxId || asString(txn.metadata['trxId']) || simId('UPTRX');
  if (input.wallet) patch['customerWallet'] = input.wallet;
  const updated = await ctx.stores.transitionTransaction(
    txn.id,
    target,
    `upay.checkout.${outcome}`,
    { txn_id: txn.gatewayTxnId, status },
    patch,
  );
  const targetUrl = buildRedirectUrl(
    asString(txn.metadata['redirectUrl']),
    status,
    asString(txn.metadata['invoiceId']),
  );
  await ctx.stores.recordEvent({
    workspaceId: txn.workspaceId,
    transactionId: txn.id,
    type: 'upay.callback.ready',
    data: {
      status,
      targetUrl,
      method: 'GET',
      note: 'customer-browser redirect; no server IPN documented',
    },
  });
  return { txn: updated, status, targetUrl };
}
