// Shared checkout completion: the mock-page buttons AND scenario actions
// (redirect_*) funnel through here so outcomes stay identical.

import { formatDbDatetime, type AppRecord, type PluginContext, type TxnRecord } from '@paysim/core';

import {
  DEFAULT_CARD_FIXTURE,
  type CardFixture,
  buildCallbackPayload,
  buildIpnPayload,
  generateRefId,
} from './builders.js';
import { applyCheckoutAction, ipnStatusFor } from './state-machine.js';
import { asString, stringifyEchoes } from './util.js';

export type CheckoutOutcome = 'success' | 'fail' | 'cancel';

export interface CompleteCheckoutInput {
  ctx: PluginContext;
  txn: TxnRecord;
  app: AppRecord | null;
  outcome: CheckoutOutcome;
  /** Skip the immediate IPN (late-IPN scenarios deliver it via a later step). */
  skipIpn?: boolean;
  /** Real-sandbox mode: provider-issued references replace generated ones. */
  provider?: { valId: string; bankTranId: string; card?: CardFixture; tranDate?: string };
}

export interface CompleteCheckoutResult {
  txn: TxnRecord;
  targetUrl: string;
  callbackPayload: Record<string, string>;
}

export async function completeCheckout(
  input: CompleteCheckoutInput,
): Promise<CompleteCheckoutResult> {
  const { ctx, txn, app, outcome } = input;
  const target = applyCheckoutAction('initiated', outcome);
  const provider = input.provider;
  const tranDate = provider?.tranDate || formatDbDatetime(ctx.clock.now(txn.workspaceId));
  const bankTranId = provider ? provider.bankTranId : generateRefId();
  const valId = outcome === 'success' ? (provider ? provider.valId : generateRefId()) : '';
  const card = provider?.card ?? DEFAULT_CARD_FIXTURE;
  const updated = await ctx.stores.transitionTransaction(
    txn.id,
    target,
    `sslcommerz.checkout.${outcome}`,
    { sessionkey: txn.gatewaySessionKey, ipnStatus: ipnStatusFor(target) },
    { valId, bankTranId, tranDate, ...(provider ? { card } : {}) },
  );

  const storePasswd = asString(app?.credentials['store_passwd']);
  const ipnUrl = asString(txn.metadata['ipnUrl']);
  if (ipnUrl && !input.skipIpn) {
    await ctx.deliverCallback({
      txn: updated,
      kind: 'ipn',
      targetUrl: ipnUrl,
      payload: buildIpnPayload({
        ipnStatus: ipnStatusFor(target),
        tranId: txn.gatewayTxnId ?? '',
        valId,
        amountMinor: txn.amountMinor,
        currencyType: asString(txn.metadata['currencyType'], txn.currency),
        storeId: asString(txn.metadata['storeId']),
        storePasswd,
        bankTranId,
        tranDate,
        card,
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
  } else if (!ipnUrl) {
    await ctx.stores.recordEvent({
      workspaceId: txn.workspaceId,
      transactionId: txn.id,
      type: 'sslcommerz.ipn.skipped',
      data: { reason: 'no ipn_url on init' },
    });
  }

  const kind = outcome === 'success' ? 'success' : outcome === 'fail' ? 'fail' : 'cancel';
  const targetUrl = asString(
    txn.metadata[
      outcome === 'success' ? 'successUrl' : outcome === 'fail' ? 'failUrl' : 'cancelUrl'
    ],
  );
  const callbackPayload = buildCallbackPayload({
    kind,
    tranId: txn.gatewayTxnId ?? '',
    valId,
    amountMinor: txn.amountMinor,
    storeId: asString(txn.metadata['storeId']),
    storePasswd,
    bankTranId,
    tranDate,
    card,
    errorText:
      outcome === 'fail'
        ? 'Payment failed at the simulator'
        : outcome === 'cancel'
          ? 'Cancelled by the customer at the simulator'
          : '',
  });
  return { txn: updated, targetUrl, callbackPayload };
}
