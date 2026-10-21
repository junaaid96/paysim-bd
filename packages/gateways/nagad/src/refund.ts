// Nagad refund (community flow, unverified like the rest of this plugin):
//   POST /remote-payment-gateway-1.0/api/dfs/check-out/refund/{merchantId}
//   body {sensitiveData, signature}; decrypted payload
//   {merchantId, paymentRefId, originalRequestDate, originalAmount,
//    cancelAmount, referenceNo, referenceMessage}
// Answers with a sealed {sensitiveData, signature} envelope whose payload
// is {status, paymentRefId, cancelAmount, cancelTrxId, refundedAmount, refundStatus}.
// referenceNo is the merchant's idempotency key. referenceMessage
// containing SIM:refund_fail simulates a declined refund.

import type { Request, Response, Router } from 'express';
import { z } from 'zod';

import {
  RefundError,
  processRefund,
  redactHeaders,
  redactValue,
  type AppRecord,
  type PluginContext,
} from '@paysim/core';

import { formatAmountMinor, parseAmountToMinor } from './builders.js';
import { NagadCryptoError } from './crypto.js';
import { asString, headersToRecord } from './util.js';

const GATEWAY = 'nagad';
export const REFUNDABLE_STATES = ['success'] as const;

const EnvelopeSchema = z.object({
  sensitiveData: z.string().min(1),
  signature: z.string().min(1),
});

const RefundPayloadSchema = z.object({
  merchantId: z.string().min(1).max(64),
  paymentRefId: z.string().min(1).max(128),
  originalRequestDate: z.string().max(32).optional(),
  originalAmount: z.string().min(1).max(32),
  cancelAmount: z.string().min(1).max(32),
  referenceNo: z.string().min(1).max(64),
  referenceMessage: z.string().max(255).optional(),
});

export interface NagadEnvelopeOps {
  open(
    app: AppRecord,
    body: { sensitiveData: string; signature: string },
  ): {
    payload: Record<string, unknown>;
  };
  seal(app: AppRecord, payload: Record<string, unknown>): Record<string, string>;
  fail(message: string): Record<string, string>;
}

export function mountNagadRefundRoutes(
  router: Router,
  ctx: PluginContext,
  base: string,
  ops: NagadEnvelopeOps,
): void {
  router.post(`${base}/check-out/refund/:merchantId`, async (req: Request, res: Response) => {
    const merchantId = asString(req.params['merchantId']);
    const app = merchantId
      ? await ctx.stores.findAppByStoreId(GATEWAY, 'merchant_id', merchantId)
      : null;
    if (!app) {
      res.status(404).json(ops.fail(`Unknown merchantId: ${merchantId}.`));
      return;
    }
    const envelope = EnvelopeSchema.safeParse(req.body);
    if (!envelope.success) {
      res.status(400).json(ops.fail('Invalid request body. Expected {sensitiveData, signature}.'));
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = ops.open(app, envelope.data).payload;
    } catch (err) {
      if (err instanceof NagadCryptoError) {
        res.status(400).json(ops.fail(err.message));
        return;
      }
      throw err;
    }
    const inner = RefundPayloadSchema.safeParse(payload);
    if (!inner.success || inner.data.merchantId !== merchantId) {
      res
        .status(400)
        .json(
          ops.fail(
            'Decrypted payload must be {merchantId, paymentRefId, originalAmount, cancelAmount, referenceNo} matching the path.',
          ),
        );
      return;
    }
    const data = inner.data;
    const txn = await ctx.stores.findTransactionBySession(GATEWAY, data.paymentRefId);
    if (!txn || txn.gatewayAppId !== app.id) {
      res.status(404).json(ops.fail(`Unknown paymentRefId: ${data.paymentRefId}.`));
      return;
    }
    const original = parseAmountToMinor(data.originalAmount);
    const cancel = parseAmountToMinor(data.cancelAmount);
    if (!original.ok || original.minor !== txn.amountMinor) {
      res.status(400).json(ops.fail('originalAmount does not match the payment amount.'));
      return;
    }
    if (!cancel.ok || cancel.minor <= 0) {
      res.status(400).json(ops.fail(`Invalid cancelAmount: ${data.cancelAmount}.`));
      return;
    }
    try {
      const result = await processRefund(ctx, txn, {
        gateway: GATEWAY,
        refundableStates: REFUNDABLE_STATES,
        amountMinor: cancel.minor,
        merchantRef: data.referenceNo,
        reason: data.referenceMessage ?? '',
        source: 'api',
        refundIdPrefix: 'NGRF',
        eventData: {
          http: {
            method: 'POST',
            path: `${base}/check-out/refund/${merchantId}`,
            headers: redactHeaders(headersToRecord(req)),
            body: redactValue({ ...(req.body as Record<string, unknown>) }),
          },
          paymentRefId: data.paymentRefId,
        },
      });
      const ok = result.entry.status === 'completed';
      res.status(200).json(
        ops.seal(app, {
          status: ok ? 'Success' : 'Failed',
          // Kept compact: the sealed payload must fit one RSA-2048 block.
          ...(ok ? {} : { message: 'Refund declined' }),
          paymentRefId: data.paymentRefId,
          cancelAmount: formatAmountMinor(result.entry.amountMinor),
          cancelTrxId: result.entry.refundId,
          refundedAmount: formatAmountMinor(result.ledger.refundedMinor),
          refundStatus: result.ledger.refundStatus,
        }),
      );
    } catch (err) {
      if (err instanceof RefundError) {
        res.status(400).json(ops.fail(err.message));
        return;
      }
      throw err;
    }
  });
}
