// SSLCommerz mock routes: session init, order validation, mock hosted
// page. Field shapes follow spec/v1.json; simulator choices are marked
// there. Business-rule failures answer HTTP 200 with {status:'FAILED',...}
// (gateway-shaped); only malformed requests get HTTP 400.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  formatDbDatetime,
  parseMagicScenario,
  redactHeaders,
  redactValue,
  ScenarioNotFoundError,
  type AppRecord,
  type PluginContext,
} from '@paysim/core';

import {
  DEFAULT_CARD_FIXTURE,
  buildInitFailure,
  buildInitResponse,
  buildValidationResponse,
  formatAmount,
  generateSessionKey,
} from './builders.js';
import { completeCheckout } from './checkout.js';
import { mountSslcommerzRefundRoutes } from './refund.js';
import { autoPostCsp, autoPostForm, checkoutPage, errorPage } from './pages.js';
import { CHECKOUT_ACTIONS, type CheckoutAction } from './state-machine.js';
import { asString, firstQueryParam, headersToRecord } from './util.js';

const GATEWAY = 'sslcommerz';

const InitSchema = z.object({
  store_id: z.string().min(1).max(30),
  store_passwd: z.string().min(1).max(128),
  total_amount: z.coerce.number().finite(),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, 'currency must be a 3-letter code')
    .transform((value) => value.toUpperCase()),
  tran_id: z.string().min(1).max(30),
  product_category: z.string().min(1).max(100),
  success_url: z.string().min(1).max(255),
  fail_url: z.string().min(1).max(255),
  cancel_url: z.string().min(1).max(255),
  ipn_url: z.string().max(255).optional(),
  value_a: z.string().max(255).optional(),
  value_b: z.string().max(255).optional(),
  value_c: z.string().max(255).optional(),
  value_d: z.string().max(255).optional(),
});
type InitData = z.infer<typeof InitSchema>;

const KNOWN_INIT_KEYS = new Set([
  'store_id',
  'store_passwd',
  'total_amount',
  'currency',
  'tran_id',
  'product_category',
  'success_url',
  'fail_url',
  'cancel_url',
  'ipn_url',
  'value_a',
  'value_b',
  'value_c',
  'value_d',
]);

/** Unknown init fields pass through into storage (documented passthrough). */
function pickExtras(body: Record<string, unknown>): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!KNOWN_INIT_KEYS.has(key)) extras[key] = value;
  }
  return extras;
}

function pickPrefixed(source: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith(prefix)) out[key] = value;
  }
  return out;
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function appName(app: AppRecord | null): string {
  return app?.name ?? 'Simulator store';
}

export function createSslcommerzRouter(ctx: PluginContext): Router {
  const router = Router();

  router.post('/gwprocess/v4/api.php', async (req: Request, res: Response) => {
    const raw = req.body as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      res.status(400).json(buildInitFailure('Invalid request body'));
      return;
    }
    const parsed = InitSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue && issue.path.length > 0 ? `: ${issue.path.join('.')}` : '';
      res.status(200).json(buildInitFailure(`Invalid init request${where}`));
      return;
    }
    const init: InitData = parsed.data;
    for (const field of ['success_url', 'fail_url', 'cancel_url', 'ipn_url'] as const) {
      const value = init[field];
      if (value !== undefined && !isAbsoluteHttpUrl(value)) {
        res.status(200).json(buildInitFailure(`${field} must be an absolute http(s) URL`));
        return;
      }
    }
    if (!(init.total_amount >= 10 && init.total_amount <= 500000)) {
      res.status(200).json(buildInitFailure('total_amount must be between 10.00 and 500000.00'));
      return;
    }
    const app = await ctx.stores.findAppByStoreId(GATEWAY, 'store_id', init.store_id);
    if (!app || app.credentials['store_passwd'] !== init.store_passwd) {
      ctx.logger.warn('sslcommerz init with unknown store or bad password', {
        store_id: init.store_id,
      });
      res.status(200).json(buildInitFailure('Invalid store credentials'));
      return;
    }
    const duplicate = await ctx.stores.findTransactionByGatewayTxnId(GATEWAY, init.tran_id, app.id);
    if (duplicate) {
      res.status(200).json(buildInitFailure('Duplicate tran_id'));
      return;
    }

    // Magic scenario marker lives in value_d (like test card numbers). An
    // unknown name fails the init loudly before any row is written.
    let resolved;
    try {
      resolved = await ctx.engine.resolveForInit({
        workspaceId: app.workspaceId,
        gateway: GATEWAY,
        defaultScenarioId: app.defaultScenarioId,
        magicName: parseMagicScenario(init.value_d),
      });
    } catch (err) {
      if (err instanceof ScenarioNotFoundError) {
        res.status(200).json(buildInitFailure(`Unknown scenario: ${err.scenarioName}`));
        return;
      }
      throw err;
    }

    const extras = pickExtras(raw as Record<string, unknown>);
    const fullInit = { ...extras, ...init };
    const now = ctx.clock.now(app.workspaceId);
    const sessionkey = generateSessionKey();
    const txn = await ctx.stores.createTransaction({
      workspaceId: app.workspaceId,
      gatewayAppId: app.id,
      gateway: GATEWAY,
      state: 'initiated',
      gatewayTxnId: init.tran_id,
      gatewaySessionKey: sessionkey,
      amountMinor: Math.round(init.total_amount * 100),
      currency: init.currency,
      customer: pickPrefixed(fullInit, 'cus_'),
      metadata: {
        storeId: init.store_id,
        currencyType: init.currency,
        productCategory: init.product_category,
        successUrl: init.success_url,
        failUrl: init.fail_url,
        cancelUrl: init.cancel_url,
        ipnUrl: init.ipn_url ?? null,
        valueA: init.value_a ?? '',
        valueB: init.value_b ?? '',
        valueC: init.value_c ?? '',
        valueD: init.value_d ?? '',
        ship: pickPrefixed(fullInit, 'ship_'),
        initPayload: redactValue(fullInit),
      },
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    });
    await ctx.stores.recordEvent({
      workspaceId: app.workspaceId,
      transactionId: txn.id,
      type: 'sslcommerz.init.received',
      data: {
        http: {
          method: 'POST',
          path: '/gwprocess/v4/api.php',
          headers: redactHeaders(headersToRecord(req)),
          body: redactValue(fullInit),
        },
        sessionkey,
        store_id: init.store_id,
      },
    });
    ctx.logger.info('sslcommerz session created', { tran_id: init.tran_id, sessionkey });
    await ctx.engine.attach({
      txn,
      scenarioId: resolved.scenarioId,
      definition: resolved.definition,
      source: resolved.source,
    });
    res.status(200).json(
      buildInitResponse({
        sessionkey,
        gatewayPageUrl: `${ctx.simBaseUrl}/gwprocess/v4/gw.php?Q=PAY&SESSIONKEY=${sessionkey}`,
      }),
    );
  });

  router.get('/validator/api/validationserverAPI.php', async (req: Request, res: Response) => {
    const format = firstQueryParam(req.query['format']) ?? 'json';
    if (format !== 'json') {
      res.status(400).json(buildInitFailure('Only format=json is supported by the simulator'));
      return;
    }
    const valId = firstQueryParam(req.query['val_id']);
    const storeId = firstQueryParam(req.query['store_id']);
    const storePasswd = firstQueryParam(req.query['store_passwd']);
    if (!valId || !storeId || !storePasswd) {
      res.status(200).json({ status: 'INVALID_TRANSACTION' });
      return;
    }
    const app = await ctx.stores.findAppByStoreId(GATEWAY, 'store_id', storeId);
    if (!app || app.credentials['store_passwd'] !== storePasswd) {
      res.status(200).json({ status: 'INVALID_TRANSACTION' });
      return;
    }
    const txn = await ctx.stores.findTransactionByMetadata(GATEWAY, 'valId', valId);
    // A store may only validate its own payments (val_ids are not secrets).
    if (!txn || txn.state !== 'valid' || txn.gatewayAppId !== app.id) {
      res.status(200).json({ status: 'INVALID_TRANSACTION' });
      return;
    }
    const priorCount =
      typeof txn.metadata['validatedCount'] === 'number' ? txn.metadata['validatedCount'] : 0;
    const result = priorCount === 0 ? 'VALID' : 'VALIDATED';
    const validatedOn =
      asString(txn.metadata['validatedOn']) || formatDbDatetime(ctx.clock.now(txn.workspaceId));
    // Same-state transition: appends metadata + writes the check event.
    await ctx.stores.transitionTransaction(
      txn.id,
      'valid',
      'sslcommerz.validation.checked',
      { val_id: valId, result },
      { validatedCount: priorCount + 1, validatedOn },
    );
    res.status(200).json(
      buildValidationResponse({
        validationStatus: result,
        validatedOn,
        tranId: txn.gatewayTxnId ?? '',
        valId,
        amountMinor: txn.amountMinor,
        currencyType: asString(txn.metadata['currencyType'], txn.currency),
        storeId,
        storePasswd,
        bankTranId: asString(txn.metadata['bankTranId']),
        tranDate: asString(txn.metadata['tranDate']),
        card: DEFAULT_CARD_FIXTURE,
        values: {
          a: asString(txn.metadata['valueA']),
          b: asString(txn.metadata['valueB']),
          c: asString(txn.metadata['valueC']),
          d: asString(txn.metadata['valueD']),
        },
      }),
    );
  });

  router.get('/gwprocess/v4/gw.php', async (req: Request, res: Response) => {
    const sessionkey = firstQueryParam(req.query['SESSIONKEY'] ?? req.query['sessionkey']);
    if (!sessionkey) {
      res
        .status(400)
        .send(errorPage('Missing session', 'SESSIONKEY query param is required.', 400));
      return;
    }
    const txn = await ctx.stores.findTransactionBySession(GATEWAY, sessionkey);
    if (!txn) {
      res
        .status(404)
        .send(errorPage('Unknown session', 'No transaction for this SESSIONKEY.', 404));
      return;
    }
    await ctx.stores.recordEvent({
      workspaceId: txn.workspaceId,
      transactionId: txn.id,
      type: 'sslcommerz.checkout.viewed',
      data: { sessionkey },
    });
    res.status(200).send(
      checkoutPage({
        tranId: txn.gatewayTxnId ?? '',
        amount: formatAmount(txn.amountMinor),
        currency: txn.currency,
        storeName: appName(await ctx.stores.getApp(txn.gatewayAppId)),
        sessionkey,
        state: txn.state,
      }),
    );
  });

  router.post('/gwprocess/v4/gw.php', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionkey =
      asString(body['SESSIONKEY']) ||
      firstQueryParam(req.query['SESSIONKEY'] ?? req.query['sessionkey']);
    const action = asString(body['action']);
    if (!sessionkey || !(CHECKOUT_ACTIONS as readonly string[]).includes(action)) {
      res
        .status(400)
        .send(
          errorPage(
            'Invalid checkout action',
            'SESSIONKEY and action=success|fail|cancel are required.',
            400,
          ),
        );
      return;
    }
    const txn = await ctx.stores.findTransactionBySession(GATEWAY, sessionkey);
    if (!txn) {
      res
        .status(404)
        .send(errorPage('Unknown session', 'No transaction for this SESSIONKEY.', 404));
      return;
    }
    const app = await ctx.stores.getApp(txn.gatewayAppId);
    if (txn.state !== 'initiated') {
      res.status(200).send(
        checkoutPage({
          tranId: txn.gatewayTxnId ?? '',
          amount: formatAmount(txn.amountMinor),
          currency: txn.currency,
          storeName: appName(app),
          sessionkey,
          state: txn.state,
          notice: `This session is already ${txn.state}; the outcome was not changed.`,
        }),
      );
      return;
    }

    const outcome = action as CheckoutAction;
    const { targetUrl, callbackPayload } = await completeCheckout({ ctx, txn, app, outcome });
    const kind = outcome === 'success' ? 'success' : outcome === 'fail' ? 'fail' : 'cancel';
    await ctx.stores.recordEvent({
      workspaceId: txn.workspaceId,
      transactionId: txn.id,
      type: 'sslcommerz.callback.rendered',
      data: { kind, targetUrl, payload: redactValue(callbackPayload) },
    });
    res.setHeader('Content-Security-Policy', autoPostCsp());
    res.status(200).send(autoPostForm(targetUrl, callbackPayload));
  });

  mountSslcommerzRefundRoutes(router, ctx);

  return router;
}
