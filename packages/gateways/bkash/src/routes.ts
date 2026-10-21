// bKash tokenized-checkout mock routes (v2 API surface). Field shapes
// follow spec/v1.json. Business-rule failures answer HTTP 200 with the
// gateway error shape; only malformed requests get HTTP 400.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  parseMagicScenario,
  redactHeaders,
  redactValue,
  ScenarioNotFoundError,
  type AppRecord,
  type PluginContext,
} from '@paysim/core';

import {
  BKASH_ERRORS,
  buildCallbackUrls,
  buildCreateResponse,
  buildExecuteResponse,
  buildGrantError,
  buildGrantResponse,
  buildPaymentError,
  buildQueryResponse,
  formatAmountMinor,
  formatBkashDatetime,
  generatePaymentId,
  generateSignature,
  generateTrxId,
  INTERNAL_CODES,
  parseAmountToMinor,
  payerAccountFor,
} from './builders.js';
import { completeVerification } from './checkout.js';
import { checkoutPage, errorPage, redirectPage } from './pages.js';
import {
  CHECKOUT_ACTIONS,
  queryStatusFor,
  type BkashState,
  type CheckoutAction,
} from './state-machine.js';
import { createTokenStore, type TokenStore } from './tokens.js';
import {
  asString,
  firstHeader,
  firstQueryParam,
  headersToRecord,
  isAbsoluteHttpUrl,
} from './util.js';

const GATEWAY = 'bkash';
const GRANT_FAIL_MESSAGE =
  'Invalid or unrecognized access credentials. Please make sure that you are using the correct access credentials issued by the Admin.';
// Doc regex for payerReference / merchantInvoiceNumber / sub-merchant fields.
const SAFE_TEXT = /^[^<>&]*$/;

const GrantBodySchema = z.object({
  app_key: z.string().min(1).max(128),
  app_secret: z.string().min(1).max(128),
});

const RefreshBodySchema = z.object({
  app_key: z.string().min(1).max(128),
  app_secret: z.string().min(1).max(128),
  refresh_token: z.string().min(1).max(256),
});

const CreateBodySchema = z.object({
  payerReference: z.string().min(1).max(255).regex(SAFE_TEXT),
  callbackURL: z.string().min(1).max(2048),
  amount: z.string().min(1).max(32),
  currency: z.string().min(1).max(8),
  intent: z.string().min(1).max(32),
  merchantInvoiceNumber: z.string().min(1).max(255).regex(SAFE_TEXT),
  subMerchantName: z.string().max(80).regex(SAFE_TEXT).optional(),
  merchantAssociationInfo: z.string().max(255).regex(SAFE_TEXT).optional(),
});
type CreateData = z.infer<typeof CreateBodySchema>;

const PaymentIdBodySchema = z.object({
  paymentId: z.string().min(1).max(64),
});

function appName(app: AppRecord | null): string {
  return app?.name ?? 'Simulator merchant';
}

/** Map a create-body zod failure to the documented error code per field. */
function createBodyError(issues: z.ZodIssue[]): Record<string, unknown> {
  const first = issues[0];
  const field = first && first.path.length > 0 ? String(first.path[0]) : '';
  if (first?.code === 'invalid_type') {
    return buildPaymentError({
      externalCode: BKASH_ERRORS.MISSING_FIELD.externalCode,
      errorMessageEn: `${BKASH_ERRORS.MISSING_FIELD.errorMessageEn}: ${field}`,
    });
  }
  switch (field) {
    case 'payerReference':
      return buildPaymentError(BKASH_ERRORS.INVALID_PAYER_REFERENCE);
    case 'callbackURL':
      return buildPaymentError(BKASH_ERRORS.INVALID_CALLBACK_URL);
    case 'amount':
      return buildPaymentError(BKASH_ERRORS.INVALID_AMOUNT);
    case 'currency':
      return buildPaymentError(BKASH_ERRORS.INVALID_CURRENCY);
    case 'intent':
      return buildPaymentError(BKASH_ERRORS.INVALID_INTENT);
    case 'merchantInvoiceNumber':
      return buildPaymentError(BKASH_ERRORS.INVALID_INVOICE);
    default:
      return buildPaymentError(BKASH_ERRORS.INVALID_BODY);
  }
}

function tokenError(): Record<string, unknown> {
  return buildPaymentError({
    externalCode: BKASH_ERRORS.PROCESS_FAILED.externalCode,
    errorMessageEn: 'Invalid or expired authorization token.',
  });
}

export function createBkashRouter(
  ctx: PluginContext,
  tokens: TokenStore = createTokenStore(ctx.stores.kv),
): Router {
  const router = Router();

  /** Resolve the calling app from Authorization + X-App-Key headers. */
  async function authenticate(req: Request, res: Response): Promise<AppRecord | null> {
    const raw = asString(firstHeader(req, 'authorization'));
    const token = raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : raw.trim();
    const peeked = token ? await tokens.peek(token) : null;
    const app = peeked ? await ctx.stores.getApp(peeked) : null;
    const nowMs = app ? ctx.clock.now(app.workspaceId).getTime() : 0;
    if (!app || !token || (await tokens.resolve(token, nowMs)) !== app.id) {
      res.status(200).json(tokenError());
      return null;
    }
    if (asString(firstHeader(req, 'x-app-key')) !== asString(app.credentials['app_key'])) {
      res.status(200).json(buildPaymentError(BKASH_ERRORS.INVALID_APP_KEY));
      return null;
    }
    return app;
  }

  router.post('/v2/tokenized-checkout/auth/grant-token', async (req: Request, res: Response) => {
    const parsed = GrantBodySchema.safeParse(req.body);
    const username = asString(firstHeader(req, 'username'));
    const password = asString(firstHeader(req, 'password'));
    if (!parsed.success || !username || !password) {
      res.status(200).json(buildGrantError('9999', GRANT_FAIL_MESSAGE));
      return;
    }
    const app = await ctx.stores.findAppByStoreId(GATEWAY, 'app_key', parsed.data.app_key);
    if (
      !app ||
      app.credentials['app_secret'] !== parsed.data.app_secret ||
      app.credentials['username'] !== username ||
      app.credentials['password'] !== password
    ) {
      ctx.logger.warn('bkash grant with unknown app or bad credentials', {
        app_key: parsed.data.app_key,
      });
      res.status(200).json(buildGrantError('9999', GRANT_FAIL_MESSAGE));
      return;
    }
    const issued = await tokens.issue(app.id, ctx.clock.now(app.workspaceId).getTime());
    ctx.logger.info('bkash token granted', { app: app.id });
    res.status(200).json(buildGrantResponse(issued));
  });

  router.post('/v2/tokenized-checkout/auth/refresh-token', async (req: Request, res: Response) => {
    const parsed = RefreshBodySchema.safeParse(req.body);
    const username = asString(firstHeader(req, 'username'));
    const password = asString(firstHeader(req, 'password'));
    if (!parsed.success || !username || !password) {
      res.status(200).json(buildGrantError('9999', GRANT_FAIL_MESSAGE));
      return;
    }
    const app = await ctx.stores.findAppByStoreId(GATEWAY, 'app_key', parsed.data.app_key);
    if (
      !app ||
      app.credentials['app_secret'] !== parsed.data.app_secret ||
      app.credentials['username'] !== username ||
      app.credentials['password'] !== password
    ) {
      ctx.logger.warn('bkash refresh with unknown app or bad credentials', {
        app_key: parsed.data.app_key,
      });
      res.status(200).json(buildGrantError('9999', GRANT_FAIL_MESSAGE));
      return;
    }
    const rotated = await tokens.refresh(
      app.id,
      parsed.data.refresh_token,
      ctx.clock.now(app.workspaceId).getTime(),
    );
    if (!rotated) {
      res.status(200).json(buildGrantError('9999', 'Invalid or expired refresh token.'));
      return;
    }
    res.status(200).json(buildGrantResponse(rotated));
  });

  router.post('/v2/tokenized-checkout/payment/create', async (req: Request, res: Response) => {
    const app = await authenticate(req, res);
    if (!app) return;
    const raw = req.body as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      res.status(400).json(buildPaymentError(BKASH_ERRORS.INVALID_BODY));
      return;
    }
    const parsed = CreateBodySchema.safeParse(raw);
    if (!parsed.success) {
      res.status(200).json(createBodyError(parsed.error.issues));
      return;
    }
    const create: CreateData = parsed.data;
    if (!isAbsoluteHttpUrl(create.callbackURL)) {
      res.status(200).json(buildPaymentError(BKASH_ERRORS.INVALID_CALLBACK_URL));
      return;
    }
    const amount = parseAmountToMinor(create.amount);
    if (!amount.ok) {
      res.status(200).json(buildPaymentError(BKASH_ERRORS.INVALID_AMOUNT));
      return;
    }
    if (create.currency !== 'BDT') {
      res.status(200).json(
        buildPaymentError({
          ...BKASH_ERRORS.INVALID_CURRENCY,
          internalCode: INTERNAL_CODES.INVALID_CURRENCY,
        }),
      );
      return;
    }
    if (create.intent !== 'sale') {
      res.status(200).json(buildPaymentError(BKASH_ERRORS.INVALID_INTENT));
      return;
    }

    // Magic scenario marker lives in merchantInvoiceNumber (like test card
    // numbers). An unknown name fails the create loudly before any row.
    let resolved;
    try {
      resolved = await ctx.engine.resolveForInit({
        workspaceId: app.workspaceId,
        gateway: GATEWAY,
        defaultScenarioId: app.defaultScenarioId,
        magicName: parseMagicScenario(create.merchantInvoiceNumber),
      });
    } catch (err) {
      if (err instanceof ScenarioNotFoundError) {
        res.status(200).json(
          buildPaymentError({
            externalCode: BKASH_ERRORS.PROCESS_FAILED.externalCode,
            errorMessageEn: `Unknown scenario: ${err.scenarioName}`,
          }),
        );
        return;
      }
      throw err;
    }

    const now = ctx.clock.now(app.workspaceId);
    const paymentId = generatePaymentId(now.getTime());
    const signature = generateSignature();
    const callbacks = buildCallbackUrls(create.callbackURL, paymentId, signature);
    const txn = await ctx.stores.createTransaction({
      workspaceId: app.workspaceId,
      gatewayAppId: app.id,
      gateway: GATEWAY,
      state: 'initiated',
      gatewaySessionKey: paymentId,
      amountMinor: amount.minor,
      currency: create.currency,
      metadata: {
        payerReference: create.payerReference,
        callbackURL: create.callbackURL,
        merchantInvoiceNumber: create.merchantInvoiceNumber,
        subMerchantName: create.subMerchantName ?? '',
        merchantAssociationInfo: create.merchantAssociationInfo ?? '',
        intent: create.intent,
        signature,
        callbackUrls: { ...callbacks },
        paymentCreateTime: formatBkashDatetime(now),
        paymentUpdateTime: formatBkashDatetime(now),
        createPayload: redactValue({ ...(raw as Record<string, unknown>) }),
      },
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    });
    await ctx.stores.recordEvent({
      workspaceId: app.workspaceId,
      transactionId: txn.id,
      type: 'bkash.create.received',
      data: {
        http: {
          method: 'POST',
          path: '/v2/tokenized-checkout/payment/create',
          headers: redactHeaders(headersToRecord(req)),
          body: redactValue({ ...(raw as Record<string, unknown>) }),
        },
        paymentId,
      },
    });
    ctx.logger.info('bkash payment created', { paymentId });
    await ctx.engine.attach({
      txn,
      scenarioId: resolved.scenarioId,
      definition: resolved.definition,
      source: resolved.source,
    });
    res.status(200).json(
      buildCreateResponse({
        paymentId,
        paymentCreateTime: formatBkashDatetime(now),
        amountMinor: amount.minor,
        currency: create.currency,
        intent: create.intent,
        merchantInvoiceNumber: create.merchantInvoiceNumber,
        bkashUrl: `${ctx.simBaseUrl}/bkash/checkout?paymentId=${paymentId}`,
        callbackURL: create.callbackURL,
        callbacks,
        signature,
      }),
    );
  });

  router.post('/v2/tokenized-checkout/payment/execute', async (req: Request, res: Response) => {
    const app = await authenticate(req, res);
    if (!app) return;
    const parsed = PaymentIdBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(200).json(
        buildPaymentError({
          externalCode: BKASH_ERRORS.INVALID_PAYMENT_ID.externalCode,
          errorMessageEn: BKASH_ERRORS.INVALID_PAYMENT_ID.errorMessageEn,
          internalCode: INTERNAL_CODES.INVALID_PAYMENT_ID,
        }),
      );
      return;
    }
    const txn = await ctx.stores.findTransactionBySession(GATEWAY, parsed.data.paymentId);
    if (!txn || txn.workspaceId !== app.workspaceId) {
      res.status(200).json(
        buildPaymentError({
          externalCode: BKASH_ERRORS.INVALID_PAYMENT_ID.externalCode,
          errorMessageEn: BKASH_ERRORS.INVALID_PAYMENT_ID.errorMessageEn,
          internalCode: INTERNAL_CODES.INVALID_PAYMENT_ID,
        }),
      );
      return;
    }
    if (txn.state === 'completed') {
      res.status(200).json(
        buildPaymentError({
          externalCode: BKASH_ERRORS.ALREADY_COMPLETED.externalCode,
          errorMessageEn: BKASH_ERRORS.ALREADY_COMPLETED.errorMessageEn,
          internalCode: INTERNAL_CODES.ALREADY_COMPLETED,
        }),
      );
      return;
    }
    if (txn.state !== 'verified') {
      if (txn.state === 'initiated') {
        res.status(200).json(buildPaymentError(BKASH_ERRORS.PREREQUISITE_NOT_MET));
        return;
      }
      if (txn.state === 'expired') {
        res.status(200).json(buildPaymentError(BKASH_ERRORS.INVALID_PAYMENT_ID));
        return;
      }
      res.status(200).json(buildPaymentError(BKASH_ERRORS.INVALID_PAYMENT_STATE));
      return;
    }
    const now = formatBkashDatetime(ctx.clock.now(txn.workspaceId));
    const trxId = generateTrxId();
    const updated = await ctx.stores.transitionTransaction(
      txn.id,
      'completed',
      'bkash.execute.completed',
      { paymentId: txn.gatewaySessionKey, trxId },
      { trxId, paymentExecuteTime: now, paymentUpdateTime: now },
    );
    res.status(200).json(
      buildExecuteResponse({
        paymentId: txn.gatewaySessionKey ?? '',
        trxId,
        amountMinor: updated.amountMinor,
        currency: updated.currency,
        intent: asString(updated.metadata['intent'], 'sale'),
        paymentExecuteTime: now,
        merchantInvoiceNumber: asString(updated.metadata['merchantInvoiceNumber']),
        subMerchantName: asString(updated.metadata['subMerchantName']),
        payerReference: asString(updated.metadata['payerReference']),
        payerAccount: payerAccountFor(asString(updated.metadata['payerReference'])),
      }),
    );
  });

  router.post('/v2/tokenized-checkout/query/payment', async (req: Request, res: Response) => {
    const app = await authenticate(req, res);
    if (!app) return;
    const parsed = PaymentIdBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(200).json(
        buildPaymentError({
          externalCode: BKASH_ERRORS.INVALID_PAYMENT_ID.externalCode,
          errorMessageEn: BKASH_ERRORS.INVALID_PAYMENT_ID.errorMessageEn,
          internalCode: INTERNAL_CODES.INVALID_PAYMENT_ID,
        }),
      );
      return;
    }
    const txn = await ctx.stores.findTransactionBySession(GATEWAY, parsed.data.paymentId);
    if (!txn || txn.workspaceId !== app.workspaceId) {
      res.status(200).json(
        buildPaymentError({
          externalCode: BKASH_ERRORS.INVALID_PAYMENT_ID.externalCode,
          errorMessageEn: BKASH_ERRORS.INVALID_PAYMENT_ID.errorMessageEn,
          internalCode: INTERNAL_CODES.INVALID_PAYMENT_ID,
        }),
      );
      return;
    }
    if (txn.state === 'expired') {
      res.status(200).json(buildPaymentError(BKASH_ERRORS.INVALID_PAYMENT_ID));
      return;
    }
    const status = queryStatusFor(txn.state as BkashState);
    await ctx.stores.recordEvent({
      workspaceId: txn.workspaceId,
      transactionId: txn.id,
      type: 'bkash.query.checked',
      data: { paymentId: txn.gatewaySessionKey, ...status },
    });
    res.status(200).json(
      buildQueryResponse({
        paymentId: txn.gatewaySessionKey ?? '',
        trxId: asString(txn.metadata['trxId']),
        amountMinor: txn.amountMinor,
        currency: txn.currency,
        intent: asString(txn.metadata['intent'], 'sale'),
        paymentCreateTime: asString(txn.metadata['paymentCreateTime']),
        paymentExecuteTime: asString(txn.metadata['paymentExecuteTime']),
        paymentUpdateTime: asString(txn.metadata['paymentUpdateTime']),
        merchantInvoiceNumber: asString(txn.metadata['merchantInvoiceNumber']),
        subMerchantName: asString(txn.metadata['subMerchantName']),
        payerReference: asString(txn.metadata['payerReference']),
        payerAccount: payerAccountFor(asString(txn.metadata['payerReference'])),
        transactionStatus: status.transactionStatus,
        verificationStatus: status.verificationStatus,
      }),
    );
  });

  router.get('/bkash/checkout', async (req: Request, res: Response) => {
    const paymentId = firstQueryParam(req.query['paymentId']);
    if (!paymentId) {
      res.status(400).send(errorPage('Missing payment', 'paymentId query param is required.', 400));
      return;
    }
    const txn = await ctx.stores.findTransactionBySession(GATEWAY, paymentId);
    if (!txn) {
      res.status(404).send(errorPage('Unknown payment', 'No transaction for this paymentId.', 404));
      return;
    }
    await ctx.stores.recordEvent({
      workspaceId: txn.workspaceId,
      transactionId: txn.id,
      type: 'bkash.checkout.viewed',
      data: { paymentId },
    });
    res.status(200).send(
      checkoutPage({
        paymentId,
        amount: formatAmountMinor(txn.amountMinor),
        currency: txn.currency,
        invoice: asString(txn.metadata['merchantInvoiceNumber']),
        appName: appName(await ctx.stores.getApp(txn.gatewayAppId)),
        state: txn.state,
      }),
    );
  });

  router.post('/bkash/checkout', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const paymentId = asString(body['paymentId']) || firstQueryParam(req.query['paymentId']);
    const action = asString(body['action']);
    if (!paymentId || !(CHECKOUT_ACTIONS as readonly string[]).includes(action)) {
      res
        .status(400)
        .send(
          errorPage(
            'Invalid checkout action',
            'paymentId and action=success|fail|cancel are required.',
            400,
          ),
        );
      return;
    }
    const txn = await ctx.stores.findTransactionBySession(GATEWAY, paymentId);
    if (!txn) {
      res.status(404).send(errorPage('Unknown payment', 'No transaction for this paymentId.', 404));
      return;
    }
    const app = await ctx.stores.getApp(txn.gatewayAppId);
    if (txn.state !== 'initiated') {
      res.status(200).send(
        checkoutPage({
          paymentId,
          amount: formatAmountMinor(txn.amountMinor),
          currency: txn.currency,
          invoice: asString(txn.metadata['merchantInvoiceNumber']),
          appName: appName(app),
          state: txn.state,
          notice: `This payment is already ${txn.state}; the outcome was not changed.`,
        }),
      );
      return;
    }
    const outcome = action as CheckoutAction;
    const { kind, targetUrl } = await completeVerification({ ctx, txn, outcome });
    res.status(200).send(redirectPage({ kind, paymentId, targetUrl }));
  });

  return router;
}
