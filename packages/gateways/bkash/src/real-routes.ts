// Provider -> PaySim browser return used only in real-sandbox mode:
//   GET /bkash/sandbox/callback?paymentID=..&status=success|failure|cancel
// bKash sends the customer here after the wallet/OTP/PIN steps. PaySim
// records the outcome and redirects to the merchant's own callback URL
// (same query shape as simulator mode). The status in the URL is not
// trusted for money: the merchant's execute call is answered by bKash.

import type { Request, Response, Router } from 'express';

import type { PluginContext } from '@paysim/core';

import { completeVerification } from './checkout.js';
import { errorPage, redirectPage } from './pages.js';
import type { CheckoutAction } from './state-machine.js';
import { firstQueryParam, asString } from './util.js';

export function mountBkashSandboxRoutes(router: Router, ctx: PluginContext): void {
  router.get('/bkash/sandbox/callback', async (req: Request, res: Response) => {
    const paymentId = firstQueryParam(req.query['paymentID']) ?? '';
    const status = (firstQueryParam(req.query['status']) ?? '').toLowerCase();
    const txn = paymentId ? await ctx.stores.findTransactionBySession('bkash', paymentId) : null;
    if (!txn || txn.metadata['sandboxMode'] !== 'real') {
      res.status(404).send(errorPage('Unknown payment', 'No real-sandbox payment here.', 404));
      return;
    }
    const outcome: CheckoutAction =
      status === 'success' ? 'success' : status === 'cancel' ? 'cancel' : 'fail';
    await ctx.stores.recordEvent({
      workspaceId: txn.workspaceId,
      transactionId: txn.id,
      type: 'bkash.sandbox.callback',
      data: { paymentID: paymentId, status },
    });
    if (txn.state !== 'initiated') {
      const stored = txn.metadata['callbackUrls'] as Record<string, unknown> | undefined;
      const kind =
        txn.state === 'cancelled' ? 'cancel' : txn.state === 'failed' ? 'failure' : 'success';
      const target = asString(
        stored?.[kind === 'cancel' ? 'cancelled' : kind === 'failure' ? 'failure' : 'success'],
      );
      res.status(200).send(redirectPage({ kind, paymentId, targetUrl: target }));
      return;
    }
    const { kind, targetUrl } = await completeVerification({ ctx, txn, outcome });
    res.status(200).send(redirectPage({ kind, paymentId, targetUrl }));
  });
}
