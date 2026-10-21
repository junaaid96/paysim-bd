// bKash tokenized-checkout refund (v2 Refund Transaction API):
//   POST /v2/tokenized-checkout/refund/payment/transaction  {paymentId, trxId, refundAmount, sku, reason}
//   POST /v2/tokenized-checkout/refund/payment/status       {paymentId, trxId}
// Same auth headers as the payment APIs. Refunds settle instantly in the
// simulator; a reason containing SIM:refund_fail simulates a decline. An
// optional Idempotency-Key header (simulator extension) makes retries safe.

import type { Request, Response, Router } from 'express';
import { z } from 'zod';

import {
  RefundError,
  processRefund,
  redactHeaders,
  redactValue,
  refundLedger,
  type AppRecord,
  type PluginContext,
  type RefundEntry,
  type TxnRecord,
} from '@paysim/core';

import {
  BKASH_ERRORS,
  buildPaymentError,
  formatAmountMinor,
  formatBkashDatetime,
  parseAmountToMinor,
} from './builders.js';
import { asString, firstHeader, headersToRecord } from './util.js';

const GATEWAY = 'bkash';
export const REFUNDABLE_STATES = ['completed'] as const;
const SAFE_TEXT = /^[^<>&]*$/;

const RefundBodySchema = z.object({
  paymentId: z.string().min(1).max(128),
  trxId: z.string().min(1).max(64),
  refundAmount: z.string().min(1).max(32),
  sku: z.string().max(255).regex(SAFE_TEXT).optional(),
  reason: z.string().max(255).regex(SAFE_TEXT).optional(),
});
const StatusBodySchema = z.object({
  paymentId: z.string().min(1).max(128),
  trxId: z.string().min(1).max(64),
});

export const REFUND_ERRORS = {
  INVALID_REFUND_AMOUNT: { externalCode: '2071', errorMessageEn: 'Invalid refund amount' },
  REFUND_EXCEEDS: {
    externalCode: '2072',
    errorMessageEn: 'Refund amount exceeds the refundable amount',
  },
  REFUND_DECLINED: { externalCode: '2003', errorMessageEn: 'Process failed' },
  DUPLICATE_REFUND: { externalCode: '2073', errorMessageEn: 'Duplicate refund request' },
} as const;

function refundView(entry: RefundEntry): Record<string, string> {
  return {
    refundTrxId: entry.refundId,
    refundTransactionStatus: entry.status === 'completed' ? 'Completed' : 'Failed',
    refundAmount: formatAmountMinor(entry.amountMinor),
    completedTime: formatBkashDatetime(new Date(entry.createdAt)),
  };
}

export function mountBkashRefundRoutes(
  router: Router,
  ctx: PluginContext,
  authenticate: (req: Request, res: Response) => Promise<AppRecord | null>,
): void {
  async function loadPayment(
    app: AppRecord,
    paymentId: string,
    trxId: string,
    res: Response,
  ): Promise<TxnRecord | null> {
    const txn = await ctx.stores.findTransactionBySession(GATEWAY, paymentId);
    if (!txn || txn.workspaceId !== app.workspaceId || txn.gatewayAppId !== app.id) {
      res.status(200).json(buildPaymentError(BKASH_ERRORS.INVALID_PAYMENT_ID));
      return null;
    }
    if (asString(txn.metadata['trxId']) !== trxId) {
      res.status(200).json(buildPaymentError(BKASH_ERRORS.INVALID_PAYMENT_STATE));
      return null;
    }
    return txn;
  }

  router.post(
    '/v2/tokenized-checkout/refund/payment/transaction',
    async (req: Request, res: Response) => {
      const app = await authenticate(req, res);
      if (!app) return;
      const parsed = RefundBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(200).json(buildPaymentError(BKASH_ERRORS.MISSING_FIELD));
        return;
      }
      const body = parsed.data;
      const amount = parseAmountToMinor(body.refundAmount);
      if (!amount.ok || amount.minor <= 0) {
        res.status(200).json(buildPaymentError(REFUND_ERRORS.INVALID_REFUND_AMOUNT));
        return;
      }
      // A completed payment can only be looked up once executed (trxId set).
      const txn = await loadPayment(app, body.paymentId, body.trxId, res);
      if (!txn) return;
      try {
        const result = await processRefund(ctx, txn, {
          gateway: GATEWAY,
          refundableStates: REFUNDABLE_STATES,
          amountMinor: amount.minor,
          merchantRef: asString(firstHeader(req, 'idempotency-key')) || null,
          reason: body.reason ?? '',
          source: 'api',
          refundIdPrefix: 'BKRF',
          eventData: {
            http: {
              method: 'POST',
              path: '/v2/tokenized-checkout/refund/payment/transaction',
              headers: redactHeaders(headersToRecord(req)),
              body: redactValue({ ...body }),
            },
            sku: body.sku ?? '',
          },
        });
        if (result.entry.status === 'failed') {
          res.status(200).json(buildPaymentError(REFUND_ERRORS.REFUND_DECLINED));
          return;
        }
        res.status(200).json({
          originalTrxId: body.trxId,
          originalTrxAmount: formatAmountMinor(txn.amountMinor),
          ...refundView(result.entry),
          currency: txn.currency,
          sku: body.sku ?? '',
          reason: result.entry.reason,
        });
      } catch (err) {
        if (err instanceof RefundError) {
          const shape =
            err.code === 'exceeds_refundable'
              ? REFUND_ERRORS.REFUND_EXCEEDS
              : err.code === 'reference_conflict'
                ? REFUND_ERRORS.DUPLICATE_REFUND
                : err.code === 'invalid_amount'
                  ? REFUND_ERRORS.INVALID_REFUND_AMOUNT
                  : BKASH_ERRORS.INVALID_PAYMENT_STATE;
          res.status(200).json(buildPaymentError(shape));
          return;
        }
        throw err;
      }
    },
  );

  router.post(
    '/v2/tokenized-checkout/refund/payment/status',
    async (req: Request, res: Response) => {
      const app = await authenticate(req, res);
      if (!app) return;
      const parsed = StatusBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(200).json(buildPaymentError(BKASH_ERRORS.MISSING_FIELD));
        return;
      }
      const txn = await loadPayment(app, parsed.data.paymentId, parsed.data.trxId, res);
      if (!txn) return;
      const ledger = refundLedger(txn);
      await ctx.stores.recordEvent({
        workspaceId: txn.workspaceId,
        transactionId: txn.id,
        type: 'bkash.refund.status.checked',
        data: { paymentId: parsed.data.paymentId, refunds: ledger.refunds.length },
      });
      res.status(200).json({
        originalTrxId: parsed.data.trxId,
        originalTrxAmount: formatAmountMinor(txn.amountMinor),
        refundTransactions: ledger.refunds.map(refundView),
      });
    },
  );
}
