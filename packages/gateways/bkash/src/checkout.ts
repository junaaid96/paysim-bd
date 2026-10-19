// Shared verification completion: the mock-page buttons AND scenario
// actions (redirect_*) funnel through here. Records the callback URL the
// customer browser would follow; tokenized checkout performs NO
// server-to-server callback, so nothing is POSTed.

import type { PluginContext, TxnRecord } from '@paysim/core';

import { formatBkashDatetime, type CallbackUrls } from './builders.js';
import { applyCheckoutAction, callbackKindFor, type CheckoutAction } from './state-machine.js';
import { asString } from './util.js';

export interface CompleteVerificationInput {
  ctx: PluginContext;
  txn: TxnRecord;
  outcome: CheckoutAction;
}

export interface CompleteVerificationResult {
  txn: TxnRecord;
  kind: 'success' | 'failure' | 'cancel';
  targetUrl: string;
}

export function callbacksFromMetadata(txn: TxnRecord): CallbackUrls {
  const stored = txn.metadata['callbackUrls'] as Partial<CallbackUrls> | undefined;
  return {
    success: asString(stored?.success),
    failure: asString(stored?.failure),
    cancelled: asString(stored?.cancelled),
  };
}

export async function completeVerification(
  input: CompleteVerificationInput,
): Promise<CompleteVerificationResult> {
  const { ctx, txn, outcome } = input;
  const target = applyCheckoutAction('initiated', outcome);
  const kind = callbackKindFor(outcome);
  const now = formatBkashDatetime(ctx.clock.now(txn.workspaceId));
  const updated = await ctx.stores.transitionTransaction(
    txn.id,
    target,
    `bkash.checkout.${outcome}`,
    { paymentId: txn.gatewaySessionKey, kind },
    { paymentUpdateTime: now },
  );
  const callbacks = callbacksFromMetadata(txn);
  const targetUrl =
    kind === 'success'
      ? callbacks.success
      : kind === 'failure'
        ? callbacks.failure
        : callbacks.cancelled;
  await ctx.stores.recordEvent({
    workspaceId: txn.workspaceId,
    transactionId: txn.id,
    type: 'bkash.callback.ready',
    data: { kind, targetUrl, method: 'GET', note: 'customer-browser redirect; no server POST' },
  });
  return { txn: updated, kind, targetUrl };
}
