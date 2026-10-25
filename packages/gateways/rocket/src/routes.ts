// Rocket (DBBL) simulator routes, mirroring DBBL's public e-commerce
// service (sources in real.ts):
//   POST /ecomws/dbblecomtxn   SOAP: getransid | getresult | getresultrocket
//   GET  /ecomws/dbblecomtxn?wsdl  (tiny WSDL pointer for SOAP clients)
//   GET/POST /ecomm2/ClientHandler?card_type=&trans_id=  customer page
// After checkout the browser returns to the merchant's return_url with
// trans_id (DBBL documents no IPN). Refunds are dashboard/ledger only.

import { timingSafeEqual } from 'node:crypto';

import express, { type Request, type Response, type Router } from 'express';

import {
  ScenarioNotFoundError,
  nextWalletStep,
  parseMagicScenario,
  redactHeaders,
  type AppRecord,
  type PluginContext,
  type TxnRecord,
} from '@paysim/core';

import { formatAmountMinor, simTransId } from './builders.js';
import { completeCheckout } from './checkout.js';
import { checkoutPage, errorPage, redirectPage } from './pages.js';
import { checkoutUrl, outcomeOf, realInit, realKeys, realResult } from './real.js';
import { OPERATIONS, parseResultLines, parseSoapRequest, soapFault, soapResponse } from './soap.js';
import {
  CHECKOUT_ACTIONS,
  resultStringFor,
  type CheckoutAction,
  type RocketState,
} from './state-machine.js';
import { asString, firstQueryParam, headersToRecord } from './util.js';

const GATEWAY = 'rocket';
/** Observed live reply to bad userid/pwd. */
export const WRONG_MERCHANT = 'Wrong Merchant ID';
/** Observed live reply to an unknown transid. */
export const INVALID_TXN = 'RESULT>Invalid Transaction ID';

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function authApp(ctx: PluginContext, f: Record<string, string>): Promise<AppRecord | null> {
  const userid = f['userid'] ?? '';
  const app = userid ? await ctx.stores.findAppByStoreId(GATEWAY, 'userid', userid) : null;
  return app && same(f['pwd'] ?? '', asString(app.credentials['pwd'])) ? app : null;
}

async function syncReal(
  ctx: PluginContext,
  txn: TxnRecord,
  app: AppRecord,
  op: 'getresult' | 'getresultrocket',
  ip: string,
): Promise<{ txn: TxnRecord; raw: string | null }> {
  const keys = realKeys(app);
  if (!keys || txn.metadata['sandboxMode'] !== 'real') return { txn, raw: null };
  const raw = await realResult(keys, op, txn.gatewaySessionKey ?? '', ip).catch(() => null);
  if (raw === null || txn.state !== 'checkout') return { txn, raw };
  const outcome = outcomeOf(raw);
  if (!outcome) return { txn, raw };
  return { txn: (await completeCheckout({ ctx, txn, outcome })).txn, raw };
}

export function createRocketRouter(ctx: PluginContext): Router {
  const router = express.Router();
  router.use(
    express.text({ type: ['text/xml', 'application/soap+xml', 'application/xml'], limit: '64kb' }),
  );
  router.use(express.urlencoded({ extended: false }));

  router.get('/ecomws/dbblecomtxn', (_req: Request, res: Response) => {
    res
      .type('text/plain')
      .send(
        'PaySim Rocket SOAP endpoint (namespace http://ecom.dbbl/). Operations: getransid, getresult, getresultrocket. Real WSDL: https://ecomtest.dutchbanglabank.com/ecomws/dbblecomtxn?wsdl',
      );
  });

  router.post('/ecomws/dbblecomtxn', async (req: Request, res: Response) => {
    const send = (op: string, value: string): void => {
      res.status(200).type('text/xml').send(soapResponse(op, value));
    };
    const parsed = typeof req.body === 'string' ? parseSoapRequest(req.body) : null;
    if (!parsed || !(OPERATIONS as readonly string[]).includes(parsed.op)) {
      res.status(500).type('text/xml').send(soapFault('Unknown or malformed SOAP operation'));
      return;
    }
    const { op, fields } = parsed;
    const app = await authApp(ctx, fields);
    if (!app) {
      send(op, WRONG_MERCHANT);
      return;
    }
    const ip = fields['clientip'] ?? '';
    if (op === 'getransid') {
      const ref = fields['txnrefnum'] ?? '';
      const amount = fields['amount'] ?? '';
      // Simulator-invented error strings (no public source shows them).
      if (!/^\d{1,12}$/.test(amount) || Number(amount) <= 0 || !ref || ref.length > 64) {
        send(op, 'error: invalid amount or txnrefnum');
        return;
      }
      if (await ctx.stores.findTransactionByGatewayTxnId(GATEWAY, ref, app.id)) {
        send(op, 'error: duplicate txnrefnum');
        return;
      }
      let resolved;
      try {
        resolved = await ctx.engine.resolveForInit({
          workspaceId: app.workspaceId,
          gateway: GATEWAY,
          defaultScenarioId: app.defaultScenarioId,
          magicName: parseMagicScenario(ref),
        });
      } catch (err) {
        if (err instanceof ScenarioNotFoundError) {
          send(op, `error: unknown scenario ${err.scenarioName}`);
          return;
        }
        throw err;
      }
      const keys = realKeys(app);
      let transId = simTransId();
      let raw: string | null = null;
      if (keys) {
        const real = await realInit(keys, { amountPaisa: amount, txnrefnum: ref, clientip: ip });
        if (!real.ok) {
          send(op, `error: DBBL sandbox: ${real.reason}`);
          return;
        }
        transId = real.transId;
        raw = real.raw;
      }
      const txn = await ctx.stores.createTransaction({
        workspaceId: app.workspaceId,
        gatewayAppId: app.id,
        gateway: GATEWAY,
        state: 'checkout',
        gatewayTxnId: ref,
        gatewaySessionKey: transId,
        amountMinor: Number(amount),
        currency: 'BDT',
        metadata: {
          returnUrl: asString(app.credentials['return_url']),
          cardType: fields['cardtype'] ?? '',
          ...(keys ? { sandboxMode: 'real' } : {}),
        },
        expiresAt: new Date(ctx.clock.now(app.workspaceId).getTime() + 30 * 60 * 1000),
      });
      await ctx.stores.recordEvent({
        workspaceId: app.workspaceId,
        transactionId: txn.id,
        type: keys ? 'rocket.sandbox.initialized' : 'rocket.init.received',
        data: {
          http: {
            method: 'POST',
            path: '/ecomws/dbblecomtxn',
            headers: redactHeaders(headersToRecord(req)),
            op,
          },
          txnrefnum: ref,
          amount_paisa: amount,
          trans_id: transId,
        },
      });
      if (!keys) {
        await ctx.engine.attach({
          txn,
          scenarioId: resolved.scenarioId,
          definition: resolved.definition,
          source: resolved.source,
        });
      }
      send(op, raw ?? `TRANSACTION_ID: ${transId}\nMRCH_TRANSACTION_ID: ${ref}`);
      return;
    }
    // getresult | getresultrocket
    const transId = fields['transid'] ?? '';
    let txn = transId ? await ctx.stores.findTransactionBySession(GATEWAY, transId) : null;
    if (!txn || txn.gatewayAppId !== app.id) {
      send(op, INVALID_TXN);
      return;
    }
    const synced = await syncReal(ctx, txn, app, op as 'getresult' | 'getresultrocket', ip);
    txn = synced.txn;
    const value = synced.raw ?? resultStringFor(txn.state as RocketState);
    await ctx.stores.recordEvent({
      workspaceId: txn.workspaceId,
      transactionId: txn.id,
      type: 'rocket.result.queried',
      data: { op, state: txn.state, result: parseResultLines(value)['RESULT'] ?? '' },
    });
    send(op, value);
  });

  async function render(
    res: Response,
    txn: TxnRecord,
    extra: Partial<Parameters<typeof checkoutPage>[0]> = {},
  ): Promise<void> {
    const app = await ctx.stores.getApp(txn.gatewayAppId);
    res.status(200).send(
      checkoutPage({
        transId: txn.gatewaySessionKey ?? '',
        amount: formatAmountMinor(txn.amountMinor),
        orderId: txn.gatewayTxnId ?? '',
        appName: app?.name ?? 'Merchant',
        state: txn.state,
        ...extra,
      }),
    );
  }

  router.get('/ecomm2/ClientHandler', async (req: Request, res: Response) => {
    const transId = firstQueryParam(req.query['trans_id']);
    const txn = transId ? await ctx.stores.findTransactionBySession(GATEWAY, transId) : null;
    if (!txn) {
      res
        .status(404)
        .send(errorPage('Unknown payment', 'No Rocket session for this trans_id.', 404));
      return;
    }
    if (txn.metadata['sandboxMode'] === 'real') {
      const keys = realKeys(await ctx.stores.getApp(txn.gatewayAppId));
      if (keys) {
        res.redirect(302, checkoutUrl(keys, txn.gatewaySessionKey ?? ''));
        return;
      }
    }
    await ctx.stores.recordEvent({
      workspaceId: txn.workspaceId,
      transactionId: txn.id,
      type: 'rocket.checkout.viewed',
      data: { trans_id: transId, card_type: firstQueryParam(req.query['card_type']) ?? '' },
    });
    await render(res, txn);
  });

  router.post('/ecomm2/ClientHandler', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const transId = asString(body['trans_id']) || firstQueryParam(req.query['trans_id']) || '';
    const txn = transId ? await ctx.stores.findTransactionBySession(GATEWAY, transId) : null;
    if (!txn || txn.metadata['sandboxMode'] === 'real') {
      res
        .status(404)
        .send(errorPage('Unknown payment', 'No Rocket session for this trans_id.', 404));
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
      ...(/^01\d{9,10}$/.test(wallet) ? { wallet } : {}),
    });
    res.status(200).send(redirectPage({ status, transId: txn.gatewaySessionKey ?? '', targetUrl }));
  });

  return router;
}
