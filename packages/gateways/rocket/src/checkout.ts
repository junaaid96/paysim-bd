// Shared checkout completion (mock page, scenario actions). DBBL documents
// no server IPN: the customer browser returns to the merchant's registered
// URL with trans_id (banglapay dbblcallback.php reads trans_id), and the
// merchant confirms with getresult / getresultrocket.

import type { PluginContext, TxnRecord } from '@paysim/core';

import { applyCheckoutAction, type CheckoutAction } from './state-machine.js';
import { asString } from './util.js';

export async function completeCheckout(input: {
  ctx: PluginContext;
  txn: TxnRecord;
  outcome: CheckoutAction;
  wallet?: string;
}): Promise<{ txn: TxnRecord; status: string; targetUrl: string }> {
  const { ctx, txn, outcome } = input;
  const target = applyCheckoutAction('checkout', outcome);
  const updated = await ctx.stores.transitionTransaction(
    txn.id,
    target,
    `rocket.checkout.${outcome}`,
    { trans_id: txn.gatewaySessionKey, state: target },
    input.wallet ? { customerWallet: input.wallet } : {},
  );
  const base = asString(txn.metadata['returnUrl']);
  const sep = base.includes('?') ? '&' : '?';
  const targetUrl = base
    ? `${base}${sep}trans_id=${encodeURIComponent(txn.gatewaySessionKey ?? '')}`
    : '';
  await ctx.stores.recordEvent({
    workspaceId: txn.workspaceId,
    transactionId: txn.id,
    type: 'rocket.callback.ready',
    data: {
      state: target,
      targetUrl,
      method: 'GET',
      note: 'customer-browser return; no server IPN documented',
    },
  });
  return { txn: updated, status: target, targetUrl };
}
