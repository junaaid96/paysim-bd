// Upay simulator routes. Paths and envelopes follow the community docs that
// cite Upay PGW API v4.1.0 (see real.ts for sources; all unverified):
//   POST /payment/merchant-auth/                 -> MAS2001 {data.token}
//   POST /payment/merchant-payment-init/         -> MPIS2002 {data.gateway_url}
//   GET  /payment/single-payment-status/:txn_id/ -> PS2005 {data.status}
//   POST /payment/bulk/refund/                   -> MPR_200 {success_list, failed_list}
// Simulator-only: GET/POST /upay/checkout (mock wallet page) and
// GET /upay/sandbox/callback/:txnId (real-sandbox return hop).
// Upay documents no server IPN: the browser redirect is the only signal.

import { createHmac, timingSafeEqual } from 'node:crypto';

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';

import {
  RefundError,
  ScenarioNotFoundError,
  nextWalletStep,
  parseMagicScenario,
  processRefund,
  redactHeaders,
  redactValue,
  type AppRecord,
  type PluginContext,
  type TxnRecord,
} from '@paysim/core';

import { formatAmountMinor, parseAmountToMinor, simId } from './builders.js';
import { completeCheckout } from './checkout.js';
import { checkoutPage, errorPage, redirectPage } from './pages.js';
import { realInit, realKeys, realStatus, settleRealRefund } from './real.js';
import { REFUNDABLE_STATES } from './refund.js';
import {
  CHECKOUT_ACTIONS,
  upayStatusFor,
  type CheckoutAction,
  type UpayState,
} from './state-machine.js';
import { asString, firstQueryParam, headersToRecord, isAbsoluteHttpUrl } from './util.js';

const GATEWAY = 'upay';
const TOKEN_TTL_S = 600;

function envelope(code: string, message: string, data?: unknown): Record<string, unknown> {
  return { code, lang: 'en', message, ...(data !== undefined ? { data } : {}) };
}

function signToken(app: AppRecord, exp: number): string {
  const body = `${app.id}.${exp}`;
  const mac = createHmac('sha256', asString(app.credentials['merchant_key']))
    .update(body)
    .digest('base64url');
  return `${Buffer.from(body).toString('base64url')}.${mac}`;
}

async function appFromToken(ctx: PluginContext, req: Request): Promise<AppRecord | null> {
  const header = asString(req.headers['authorization']);
  const match = /^UPAY\s+(\S+)$/i.exec(header);
  if (!match) return null;
  const [b64, mac] = match[1]!.split('.');
  if (!b64 || !mac) return null;
  const body = Buffer.from(b64, 'base64url').toString('utf8');
  const [appId, expText] = body.split('.');
  if (!appId || Number(expText) < Date.now() / 1000) return null;
  const app = await ctx.stores.getApp(appId);
  if (!app || app.gateway !== GATEWAY) return null;
  const expected = signToken(app, Number(expText)).split('.')[1]!;
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? app : null;
}

function appName(app: AppRecord | null): string {
  return app?.name ?? 'Merchant';
}

function http(req: Request, path: string): Record<string, unknown> {
  return {
    method: req.method,
    path,
    headers: redactHeaders(headersToRecord(req)),
    body: redactValue(req.body as unknown),
  };
}

const InitSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  txn_id: z.string().min(1).max(64),
  invoice_id: z.string().min(1).max(64),
  amount: z.union([z.string(), z.number()]),
  transaction_currency_code: z.literal('BDT').optional(),
  redirect_url: z.string().min(1).max(2048),
  merchant_id: z.string().min(1).max(64),
  merchant_name: z.string().max(128).optional(),
  merchant_code: z.string().max(64).optional(),
  merchant_country_code: z.string().max(4).optional(),
  merchant_city: z.string().max(64).optional(),
  merchant_category_code: z.string().max(16).optional(),
  merchant_mobile: z.string().max(20).optional(),
  additional_info: z.unknown().optional(),
});

function statusData(txn: TxnRecord, app: AppRecord | null): Record<string, unknown> {
  return {
    txn_id: txn.gatewayTxnId,
    trx_id: asString(txn.metadata['trxId']) || null,
    invoice_id: asString(txn.metadata['invoiceId']),
    session_id: txn.gatewaySessionKey,
    status: upayStatusFor(txn.state as UpayState),
    amount: Number(formatAmountMinor(txn.amountMinor)),
    merchant_name: asString(txn.metadata['merchantName']) || appName(app),
    customer_wallet: asString(txn.metadata['customerWallet']) || null,
    date: asString(txn.metadata['date']),
  };
}

/** Real mode: ask Upay and settle the local txn when it has an answer. */
async function syncReal(ctx: PluginContext, txn: TxnRecord, app: AppRecord): Promise<TxnRecord> {
  const keys = realKeys(app);
  if (!keys || txn.metadata['sandboxMode'] !== 'real' || txn.state !== 'checkout') return txn;
  const providerTxn = asString(txn.metadata['providerTxnId']);
  const remote = await realStatus(ctx, app, keys, providerTxn).catch(() => null);
  if (!remote || remote.status === 'pending') return txn;
  if (remote.status === 'success') {
    const amt = parseAmountToMinor(remote.amount);
    {
      if (!amt.ok || amt.minor !== txn.amountMinor) {
        await ctx.stores.recordEvent({
          workspaceId: txn.workspaceId,
          transactionId: txn.id,
          type: 'upay.sandbox.amount_mismatch',
          data: { expected: formatAmountMinor(txn.amountMinor), reported: remote.amount },
        });
        return ctx.stores.transitionTransaction(txn.id, 'failed', 'upay.sandbox.verified', {
          status: 'amount_mismatch',
        });
      }
    }
    return (
      await completeCheckout({
        ctx,
        txn,
        outcome: 'success',
        providerTrxId: remote.trxId,
        wallet: remote.wallet,
      })
    ).txn;
  }
  if (remote.status === 'expired') {
    return ctx.stores.transitionTransaction(txn.id, 'expired', 'upay.sandbox.verified', {
      status: 'expired',
    });
  }
  const outcome: CheckoutAction =
    remote.status === 'cancelled' || remote.status === 'canceled' ? 'cancel' : 'fail';
  return (await completeCheckout({ ctx, txn, outcome })).txn;
}

export function createUpayRouter(ctx: PluginContext): Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));

  router.post('/payment/merchant-auth/', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const merchantId = asString(body['merchant_id']);
    const merchantKey = asString(body['merchant_key']);
    if (!merchantId || !merchantKey) {
      res.status(400).json(envelope('DVE4001', 'Data Validation Error'));
      return;
    }
    const app = await ctx.stores.findAppByStoreId(GATEWAY, 'merchant_id', merchantId);
    const expected = asString(app?.credentials['merchant_key']);
    const a = Buffer.from(merchantKey);
    const b = Buffer.from(expected);
    if (!app || a.length !== b.length || !timingSafeEqual(a, b)) {
      // Simulator-invented code: no source shows the bad-credential reply.
      res.status(401).json(envelope('MAE4001', 'Invalid merchant credentials'));
      return;
    }
    const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;
    res
      .status(200)
      .json(
        envelope('MAS2001', 'Merchant authorization successful', { token: signToken(app, exp) }),
      );
  });

  router.post('/payment/merchant-payment-init/', async (req: Request, res: Response) => {
    const app = await appFromToken(ctx, req);
    if (!app) {
      res.status(401).json(envelope('UNA4001', 'Unauthorized'));
      return;
    }
    const parsed = InitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(
        envelope('DVE4001', 'Data Validation Error', {
          fields: parsed.error.issues.map((i) => i.path.join('.')),
        }),
      );
      return;
    }
    const body = parsed.data;
    const amount = parseAmountToMinor(body.amount);
    if (
      !amount.ok ||
      body.merchant_id !== asString(app.credentials['merchant_id']) ||
      !isAbsoluteHttpUrl(body.redirect_url)
    ) {
      res.status(400).json(envelope('DVE4001', 'Data Validation Error'));
      return;
    }
    if (await ctx.stores.findTransactionByGatewayTxnId(GATEWAY, body.txn_id, app.id)) {
      res.status(400).json(envelope('DTP4003', 'Duplicate transaction id'));
      return;
    }
    let resolved;
    try {
      resolved = await ctx.engine.resolveForInit({
        workspaceId: app.workspaceId,
        gateway: GATEWAY,
        defaultScenarioId: app.defaultScenarioId,
        magicName: parseMagicScenario(body.invoice_id) ?? parseMagicScenario(body.txn_id),
      });
    } catch (err) {
      if (err instanceof ScenarioNotFoundError) {
        res.status(400).json(envelope('DVE4001', `Unknown scenario: ${err.scenarioName}`));
        return;
      }
      throw err;
    }
    const sessionId = simId('UPS', 10);
    const trxId = simId('UPTRX');
    const txn = await ctx.stores.createTransaction({
      workspaceId: app.workspaceId,
      gatewayAppId: app.id,
      gateway: GATEWAY,
      state: 'checkout',
      gatewayTxnId: body.txn_id,
      gatewaySessionKey: sessionId,
      amountMinor: amount.minor,
      currency: 'BDT',
      metadata: {
        invoiceId: body.invoice_id,
        redirectUrl: body.redirect_url,
        merchantName: body.merchant_name ?? '',
        date: body.date,
        trxId,
        initPayload: redactValue({ ...body }),
      },
      expiresAt: new Date(ctx.clock.now(app.workspaceId).getTime() + 30 * 60 * 1000),
    });
    await ctx.stores.recordEvent({
      workspaceId: app.workspaceId,
      transactionId: txn.id,
      type: 'upay.init.received',
      data: { http: http(req, '/payment/merchant-payment-init/'), session_id: sessionId },
    });
    let gatewayUrl = `${ctx.simBaseUrl}/upay/checkout?session_id=${sessionId}`;
    const keys = realKeys(app);
    if (keys) {
      const real = await realInit(ctx, app, keys, txn);
      if (!real.ok) {
        await ctx.stores.transitionTransaction(
          txn.id,
          'failed',
          'upay.sandbox.init_failed',
          { reason: real.reason },
          { sandboxMode: 'real' },
        );
        res.status(400).json(envelope('SBX5001', `Upay sandbox: ${real.reason}`));
        return;
      }
      gatewayUrl = real.gatewayUrl;
      await ctx.stores.transitionTransaction(
        txn.id,
        'checkout',
        'upay.sandbox.initialized',
        { providerTxnId: real.txnId, gateway_url: real.gatewayUrl },
        {
          sandboxMode: 'real',
          providerTxnId: real.txnId,
          providerSessionId: real.sessionId,
          ...(real.trxId ? { trxId: real.trxId } : {}),
        },
      );
    } else {
      await ctx.engine.attach({
        txn,
        scenarioId: resolved.scenarioId,
        definition: resolved.definition,
        source: resolved.source,
      });
    }
    res.status(200).json(
      envelope('MPIS2002', 'Payment initiated', {
        session_id: sessionId,
        txn_id: body.txn_id,
        trx_id: trxId,
        invoice_id: body.invoice_id,
        merchant_id: body.merchant_id,
        gateway_url: gatewayUrl,
      }),
    );
  });

  router.get('/payment/single-payment-status/:txnId/', async (req: Request, res: Response) => {
    const app = await appFromToken(ctx, req);
    if (!app) {
      res.status(401).json(envelope('UNA4001', 'Unauthorized'));
      return;
    }
    const txnId = asString(req.params['txnId']);
    let txn = await ctx.stores.findTransactionByGatewayTxnId(GATEWAY, txnId, app.id);
    if (!txn) {
      res.status(404).json(envelope('PNF4012', 'Payment not found'));
      return;
    }
    txn = await syncReal(ctx, txn, app);
    await ctx.stores.recordEvent({
      workspaceId: txn.workspaceId,
      transactionId: txn.id,
      type: 'upay.status.queried',
      data: {
        http: http(req, `/payment/single-payment-status/${txnId}/`),
        status: upayStatusFor(txn.state as UpayState),
      },
    });
    res.status(200).json(envelope('PS2005', 'Payment status', statusData(txn, app)));
  });

  router.post('/payment/bulk/refund/', async (req: Request, res: Response) => {
    const app = await appFromToken(ctx, req);
    if (!app) {
      res.status(401).json(envelope('UNA4001', 'Unauthorized'));
      return;
    }
    const items = Array.isArray(req.body) ? (req.body as unknown[]) : null;
    if (!items || items.length === 0 || items.length > 50) {
      res.status(400).json(envelope('DVE4001', 'Data Validation Error'));
      return;
    }
    const success: string[] = [];
    const failed: Record<string, { en: string; bn: string }> = {};
    for (const raw of items) {
      const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const txnId = asString(item['txn_id']);
      const fail = (en: string): void => {
        failed[txnId || '(missing)'] = { en, bn: en };
      };
      const txn = txnId
        ? await ctx.stores.findTransactionByGatewayTxnId(GATEWAY, txnId, app.id)
        : null;
      if (!txn) {
        fail('Payment not found');
        continue;
      }
      const amount = parseAmountToMinor(item['refund_amount'] ?? item['amount']);
      if (!amount.ok) {
        fail('Invalid refund amount');
        continue;
      }
      try {
        const result = await processRefund(ctx, txn, {
          gateway: GATEWAY,
          refundableStates: REFUNDABLE_STATES,
          amountMinor: amount.minor,
          merchantRef: asString(item['reference']) || null,
          reason: asString(item['reason']) || 'Upay bulk refund',
          source: 'api',
          refundIdPrefix: 'UPRF',
          ...(realKeys(app) && txn.metadata['sandboxMode'] === 'real'
            ? { settle: (input) => settleRealRefund(ctx, txn, app, input) }
            : {}),
          eventData: { http: http(req, '/payment/bulk/refund/'), txn_id: txnId },
        });
        if (result.entry.status === 'completed') success.push(txnId);
        else fail(result.entry.failureReason ?? 'Refund declined');
      } catch (err) {
        if (err instanceof RefundError) fail(err.message);
        else throw err;
      }
    }
    res.status(200).json(
      envelope('MPR_200', 'Refund request processed', {
        success_list: success,
        failed_list: failed,
      }),
    );
  });

  async function render(
    res: Response,
    txn: TxnRecord,
    extra: Partial<Parameters<typeof checkoutPage>[0]> = {},
  ): Promise<void> {
    const app = await ctx.stores.getApp(txn.gatewayAppId);
    res.status(200).send(
      checkoutPage({
        sessionId: txn.gatewaySessionKey ?? '',
        amount: formatAmountMinor(txn.amountMinor),
        orderId: asString(txn.metadata['invoiceId']),
        appName: appName(app),
        state: txn.state,
        ...extra,
      }),
    );
  }

  router.get('/upay/checkout', async (req: Request, res: Response) => {
    const sessionId = firstQueryParam(req.query['session_id']);
    const txn = sessionId ? await ctx.stores.findTransactionBySession(GATEWAY, sessionId) : null;
    if (!txn) {
      res
        .status(404)
        .send(errorPage('Unknown payment', 'No Upay session for this session_id.', 404));
      return;
    }
    await ctx.stores.recordEvent({
      workspaceId: txn.workspaceId,
      transactionId: txn.id,
      type: 'upay.checkout.viewed',
      data: { session_id: sessionId },
    });
    await render(res, txn);
  });

  router.post('/upay/checkout', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId =
      asString(body['session_id']) || firstQueryParam(req.query['session_id']) || '';
    const txn = sessionId ? await ctx.stores.findTransactionBySession(GATEWAY, sessionId) : null;
    if (!txn) {
      res
        .status(404)
        .send(errorPage('Unknown payment', 'No Upay session for this session_id.', 404));
      return;
    }
    const action = asString(body['action']);
    if (action === '' && typeof body['step'] === 'string') {
      const next = nextWalletStep(body);
      await render(res, txn, {
        step: next.step,
        wallet: next.wallet,
        ...(next.error ? { error: next.error } : {}),
      });
      return;
    }
    if (!(CHECKOUT_ACTIONS as readonly string[]).includes(action)) {
      res
        .status(400)
        .send(errorPage('Invalid checkout action', 'action=success|fail|cancel is required.', 400));
      return;
    }
    if (txn.state !== 'checkout') {
      await render(res, txn, {
        notice: `This payment is already ${txn.state}; the outcome was not changed.`,
      });
      return;
    }
    const wallet = asString(body['wallet']).replace(/\s+/g, '');
    const { status, targetUrl } = await completeCheckout({
      ctx,
      txn,
      outcome: action as CheckoutAction,
      ...(/^01\d{9}$/.test(wallet) ? { wallet } : {}),
    });
    res.status(200).send(redirectPage({ status, txnId: txn.gatewayTxnId ?? '', targetUrl }));
  });

  // Real sandbox: Upay returns the browser here (status+invoice_id appended,
  // unsigned). Confirm with single-payment-status, then forward to the
  // merchant's redirect_url exactly like the simulator does.
  router.get('/upay/sandbox/callback/:txnId', async (req: Request, res: Response) => {
    const id = asString(req.params['txnId']).split(/[?&]/)[0] ?? '';
    const txn = /^[A-Za-z0-9-]{1,64}$/.test(id) ? await ctx.stores.getTransaction(id) : null;
    if (!txn || txn.gateway !== GATEWAY || txn.metadata['sandboxMode'] !== 'real') {
      res.status(404).send(errorPage('Unknown payment', 'No real-sandbox payment here.', 404));
      return;
    }
    const app = await ctx.stores.getApp(txn.gatewayAppId);
    await ctx.stores.recordEvent({
      workspaceId: txn.workspaceId,
      transactionId: txn.id,
      type: 'upay.sandbox.returned',
      data: { reported: redactValue({ ...req.query }) },
    });
    const settled = app ? await syncReal(ctx, txn, app) : txn;
    if (settled.state === 'checkout') {
      res
        .status(200)
        .send(
          errorPage(
            'Payment pending',
            'Upay has not confirmed this payment yet. Refresh in a moment.',
            202,
          ),
        );
      return;
    }
    const status = upayStatusFor(settled.state as UpayState);
    const base = asString(txn.metadata['redirectUrl']);
    const sep = base.includes('?') ? '&' : '?';
    res.redirect(
      302,
      `${base}${sep}status=${status}&invoice_id=${encodeURIComponent(asString(txn.metadata['invoiceId']))}`,
    );
  });

  return router;
}
