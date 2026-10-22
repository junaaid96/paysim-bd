// SSLCommerz refund API (merchantTransIDvalidationAPI.php). One GET
// endpoint, dispatched by parameters like the real one:
//   bank_tran_id + refund_amount + refund_remarks -> initiate refund
//   refund_ref_id                                  -> refund status
// Shapes follow developer.sslcommerz.com/doc/v4 (Refund API). The
// simulator settles refunds instantly (status "success" / "refunded");
// refund_remarks containing SIM:refund_fail simulates a declined refund.

import type { Request, Response, Router } from 'express';

import {
  RefundError,
  formatDbDatetime,
  processRefund,
  redactValue,
  refundIndexKey,
  refundLedger,
  type PluginContext,
  type RefundEntry,
  type TxnRecord,
} from '@paysim/core';

import { realKeys, settleRealRefund } from './real.js';
import { firstQueryParam } from './util.js';

const GATEWAY = 'sslcommerz';
export const REFUNDABLE_STATES = ['valid'] as const;
const AMOUNT = /^\d{1,9}(\.\d{1,2})?$/;

function findByRefundRef(txn: TxnRecord, refundRefId: string): RefundEntry | null {
  return refundLedger(txn).refunds.find((entry) => entry.refundId === refundRefId) ?? null;
}

/** Query string with secrets (store_passwd) redacted, for the timeline. */
function redactedQuery(req: Request): string {
  const redacted = redactValue({ ...(req.query as Record<string, unknown>) });
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(redacted)) params.set(key, String(value));
  return params.toString();
}

export function mountSslcommerzRefundRoutes(router: Router, ctx: PluginContext): void {
  router.get(
    '/validator/api/merchantTransIDvalidationAPI.php',
    async (req: Request, res: Response) => {
      const q = (key: string): string => firstQueryParam(req.query[key]) ?? '';
      const storeId = q('store_id');
      const storePasswd = q('store_passwd');
      const app = storeId ? await ctx.stores.findAppByStoreId(GATEWAY, 'store_id', storeId) : null;
      if (!app || app.credentials['store_passwd'] !== storePasswd) {
        res
          .status(200)
          .json({ APIConnect: 'INVALID_REQUEST', errorReason: 'Invalid store credentials' });
        return;
      }

      const refundRefId = q('refund_ref_id');
      if (refundRefId && !q('refund_amount')) {
        const txn = await ctx.stores.findTransactionByMetadata(
          GATEWAY,
          refundIndexKey(refundRefId),
          '1',
        );
        const entry = txn && txn.gatewayAppId === app.id ? findByRefundRef(txn, refundRefId) : null;
        if (!txn || !entry) {
          res.status(200).json({
            APIConnect: 'DONE',
            refund_ref_id: refundRefId,
            status: 'failed',
            errorReason: 'Invalid refund_ref_id',
          });
          return;
        }
        await ctx.stores.recordEvent({
          workspaceId: txn.workspaceId,
          transactionId: txn.id,
          type: 'sslcommerz.refund.status.checked',
          data: { refund_ref_id: refundRefId, status: entry.status },
        });
        const at = formatDbDatetime(new Date(entry.createdAt));
        res.status(200).json({
          APIConnect: 'DONE',
          bank_tran_id: String(txn.metadata['bankTranId'] ?? ''),
          tran_id: txn.gatewayTxnId ?? '',
          refund_ref_id: entry.refundId,
          initiated_on: at,
          refunded_on: entry.status === 'completed' ? at : '',
          status: entry.status === 'completed' ? 'refunded' : 'cancelled',
          errorReason: entry.failureReason ?? '',
        });
        return;
      }

      const bankTranId = q('bank_tran_id');
      const rawAmount = q('refund_amount');
      const remarks = q('refund_remarks');
      if (!bankTranId || !rawAmount || !remarks) {
        res.status(200).json({
          APIConnect: 'INVALID_REQUEST',
          errorReason:
            'bank_tran_id, refund_amount and refund_remarks are required (or refund_ref_id for status).',
        });
        return;
      }
      const txn = await ctx.stores.findTransactionByMetadata(GATEWAY, 'bankTranId', bankTranId);
      if (!txn || txn.gatewayAppId !== app.id) {
        res.status(200).json({
          APIConnect: 'DONE',
          bank_tran_id: bankTranId,
          status: 'failed',
          errorReason: 'Invalid bank_tran_id',
        });
        return;
      }
      if (!AMOUNT.test(rawAmount)) {
        res.status(200).json({
          APIConnect: 'DONE',
          bank_tran_id: bankTranId,
          status: 'failed',
          errorReason: 'Invalid refund_amount',
        });
        return;
      }
      // refund_trans_id is the merchant's unique refund id (idempotency key);
      // older integrations send refe_id instead.
      const merchantRef = q('refund_trans_id') || q('refe_id') || null;
      try {
        const result = await processRefund(ctx, txn, {
          gateway: GATEWAY,
          refundableStates: REFUNDABLE_STATES,
          amountMinor: Math.round(Number(rawAmount) * 100),
          merchantRef,
          reason: remarks,
          source: 'api',
          refundIdPrefix: 'SSLRF',
          ...(realKeys(app) && txn.metadata['sandboxMode'] === 'real'
            ? { settle: (input) => settleRealRefund(ctx, txn, app, input) }
            : {}),
          eventData: {
            http: {
              method: 'GET',
              path: `/validator/api/merchantTransIDvalidationAPI.php?${redactedQuery(req)}`,
            },
          },
        });
        res.status(200).json({
          APIConnect: 'DONE',
          bank_tran_id: bankTranId,
          trans_id: txn.gatewayTxnId ?? '',
          refund_ref_id: result.entry.refundId,
          status: result.entry.status === 'completed' ? 'success' : 'failed',
          errorReason: result.entry.failureReason ?? '',
        });
      } catch (err) {
        if (err instanceof RefundError) {
          res.status(200).json({
            APIConnect: 'DONE',
            bank_tran_id: bankTranId,
            status: 'failed',
            errorReason: err.message,
          });
          return;
        }
        throw err;
      }
    },
  );
}
