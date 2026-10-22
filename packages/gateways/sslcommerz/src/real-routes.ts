// Provider -> PaySim endpoints used only in real-sandbox mode:
//   POST /gwprocess/sandbox/return/:txnId/:kind  (customer browser, from SSLCommerz)
//   POST /gwprocess/sandbox/ipn/:txnId           (SSLCommerz IPN)
// Success is never trusted from the POST body: PaySim re-validates the
// val_id with the provider's validation API before recording it.

import type { Request, Response, Router } from 'express';

import { redactValue, type PluginContext, type TxnRecord } from '@paysim/core';

import { buildCallbackPayload, type CardFixture } from './builders.js';
import { completeCheckout, type CheckoutOutcome } from './checkout.js';
import { autoPostCsp, autoPostForm, errorPage } from './pages.js';
import { realKeys, validateWithProvider } from './real.js';
import { asString } from './util.js';

const UUID = /^[A-Za-z0-9-]{1,64}$/;

function kindOf(raw: string): CheckoutOutcome | null {
  return raw === 'success' || raw === 'fail' || raw === 'cancel' ? raw : null;
}

/** Merchant callback for a payment that is already settled (IPN won the race). */
function existingCallback(
  txn: TxnRecord,
  storePasswd: string,
): { targetUrl: string; payload: Record<string, string> } {
  const kind: CheckoutOutcome =
    txn.state === 'valid' ? 'success' : txn.state === 'cancelled' ? 'cancel' : 'fail';
  const key = kind === 'success' ? 'successUrl' : kind === 'fail' ? 'failUrl' : 'cancelUrl';
  const card = (txn.metadata['card'] as CardFixture | undefined) ?? {
    cardType: '',
    cardNo: '',
    cardIssuer: '',
    cardBrand: '',
    cardIssuerCountry: '',
    cardIssuerCountryCode: '',
  };
  return {
    targetUrl: asString(txn.metadata[key]),
    payload: buildCallbackPayload({
      kind,
      tranId: txn.gatewayTxnId ?? '',
      valId: asString(txn.metadata['valId']),
      amountMinor: txn.amountMinor,
      storeId: asString(txn.metadata['storeId']),
      storePasswd,
      bankTranId: asString(txn.metadata['bankTranId']),
      tranDate: asString(txn.metadata['tranDate']),
      card,
      errorText: kind === 'success' ? '' : 'Payment was not completed in the SSLCommerz sandbox',
    }),
  };
}

export function mountSslcommerzSandboxRoutes(router: Router, ctx: PluginContext): void {
  /**
   * Settle a real-sandbox payment from a provider signal. Returns the
   * (possibly unchanged) txn plus the freshly built merchant callback.
   */
  async function settle(
    txn: TxnRecord,
    requested: CheckoutOutcome,
    body: Record<string, unknown>,
    source: 'return' | 'ipn',
  ): Promise<{ txn: TxnRecord; targetUrl: string; payload: Record<string, string> } | null> {
    const app = await ctx.stores.getApp(txn.gatewayAppId);
    const keys = realKeys(app);
    const storePasswd = asString(app?.credentials['store_passwd']);
    await ctx.stores.recordEvent({
      workspaceId: txn.workspaceId,
      transactionId: txn.id,
      type: `sslcommerz.sandbox.${source}`,
      data: { requested, body: redactValue({ ...body }) },
    });
    const fresh = (await ctx.stores.getTransaction(txn.id)) ?? txn;
    if (fresh.state !== 'initiated' || !keys) {
      const existing = existingCallback(fresh, storePasswd);
      return { txn: fresh, ...existing };
    }
    let outcome: CheckoutOutcome = requested;
    let provider: Parameters<typeof completeCheckout>[0]['provider'];
    const valId = asString(body['val_id']);
    if (requested === 'success') {
      const check = valId ? await validateWithProvider(fresh, keys, valId) : null;
      await ctx.stores.recordEvent({
        workspaceId: fresh.workspaceId,
        transactionId: fresh.id,
        type: 'sslcommerz.sandbox.validated',
        data: {
          val_id: valId,
          ok: check?.ok ?? false,
          status: check?.status ?? 'missing val_id',
          reason: check?.reason ?? '',
        },
      });
      if (!check?.ok) {
        // Unverifiable "success" is treated as a failure (never trust the body).
        outcome = 'fail';
        provider = { valId: '', bankTranId: asString(body['bank_tran_id']) };
      } else {
        provider = {
          valId,
          bankTranId: check.bankTranId,
          card: check.card,
          tranDate: check.tranDate,
        };
      }
    } else {
      provider = { valId: '', bankTranId: asString(body['bank_tran_id']) };
    }
    const done = await completeCheckout({ ctx, txn: fresh, app, outcome, provider });
    return { txn: done.txn, targetUrl: done.targetUrl, payload: done.callbackPayload };
  }

  router.post('/gwprocess/sandbox/return/:txnId/:kind', async (req: Request, res: Response) => {
    const txnId = String(req.params['txnId'] ?? '');
    const kind = kindOf(String(req.params['kind'] ?? ''));
    const txn = UUID.test(txnId) ? await ctx.stores.getTransaction(txnId) : null;
    if (!kind || !txn || txn.gateway !== 'sslcommerz' || txn.metadata['sandboxMode'] !== 'real') {
      res.status(404).send(errorPage('Unknown payment', 'No real-sandbox payment here.', 404));
      return;
    }
    const result = await settle(txn, kind, (req.body ?? {}) as Record<string, unknown>, 'return');
    if (!result || !result.targetUrl) {
      res.status(200).send(errorPage('Payment recorded', 'The merchant has no return URL.', 200));
      return;
    }
    res.setHeader('Content-Security-Policy', autoPostCsp());
    res.status(200).send(autoPostForm(result.targetUrl, result.payload));
  });

  router.post('/gwprocess/sandbox/ipn/:txnId', async (req: Request, res: Response) => {
    const txnId = String(req.params['txnId'] ?? '');
    const txn = UUID.test(txnId) ? await ctx.stores.getTransaction(txnId) : null;
    if (!txn || txn.gateway !== 'sslcommerz' || txn.metadata['sandboxMode'] !== 'real') {
      res.status(404).json({ status: 'UNKNOWN' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = asString(body['status']).toUpperCase();
    const requested: CheckoutOutcome =
      status === 'VALID' || status === 'VALIDATED'
        ? 'success'
        : status === 'CANCELLED'
          ? 'cancel'
          : 'fail';
    // UNATTEMPTED / EXPIRED IPNs are logged but don't close an open session.
    if (status === 'UNATTEMPTED' || status === 'EXPIRED') {
      await ctx.stores.recordEvent({
        workspaceId: txn.workspaceId,
        transactionId: txn.id,
        type: 'sslcommerz.sandbox.ipn',
        data: { requested: status, body: redactValue({ ...body }) },
      });
      res.status(200).json({ status: 'OK' });
      return;
    }
    await settle(txn, requested, body, 'ipn');
    res.status(200).json({ status: 'OK' });
  });
}
