// Nagad checkout mock routes (community flow — everything unverified,
// see spec/v1.json). Mutual RSA with fake keys: requests are decrypted
// with the fixture Nagad private key and verified against each app's
// merchant public key; responses are encrypted for the merchant and
// signed with the fixture key. Error shapes are simulator-invented
// ({status:'Failed', message} over HTTP 400/404): no source shows real
// error bodies.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  nextWalletStep,
  parseMagicScenario,
  redactHeaders,
  redactValue,
  refundLedger,
  ScenarioNotFoundError,
  type AppRecord,
  type PluginContext,
} from '@paysim/core';

import {
  buildCallbackUrl,
  formatAmountMinor,
  generateChallenge,
  generatePaymentReferenceId,
  parseAmountToMinor,
} from './builders.js';
import { completeCheckout } from './checkout.js';
import { NagadCryptoError, rsaDecrypt, rsaEncrypt, rsaSign, rsaVerify } from './crypto.js';
import { loadFixtureKeys } from './fixtures.js';
import { checkoutPage, errorPage, redirectPage } from './pages.js';
import { mountNagadRefundRoutes } from './refund.js';
import { providerOrderId, realComplete, realInitialize, realKeys, realVerify } from './real.js';
import { CHECKOUT_ACTIONS, verifyStatusFor, type CheckoutAction } from './state-machine.js';
import { asString, firstQueryParam, headersToRecord, isAbsoluteHttpUrl } from './util.js';

const GATEWAY = 'nagad';
const BASE = '/remote-payment-gateway-1.0/api/dfs';

const InitBodySchema = z.object({
  dateTime: z.string().regex(/^\d{14}$/),
  sensitiveData: z.string().min(1),
  signature: z.string().min(1),
});

const CompleteBodySchema = z.object({
  dateTime: z.string().regex(/^\d{14}$/),
  sensitiveData: z.string().min(1),
  signature: z.string().min(1),
  merchantCallbackURL: z.string().min(1).max(2048),
  additionalMerchantInfo: z.unknown(),
});

const InitPayloadSchema = z.object({
  merchantId: z.string().min(1).max(64),
  orderId: z.string().min(1).max(128),
  challenge: z.string().min(1).max(128),
});

const CompletePayloadSchema = z.object({
  merchantId: z.string().min(1).max(64),
  orderId: z.string().min(1).max(128),
  amount: z.string().min(1).max(32),
  challenge: z.string().min(1).max(128),
});

function appName(app: AppRecord | null): string {
  return app?.name ?? 'Simulator merchant';
}

/** Simulator-invented error shape (documented; no source shows real ones). */
function fail(message: string): Record<string, string> {
  return { status: 'Failed', message };
}

export function createNagadRouter(ctx: PluginContext): Router {
  const router = Router();
  const fixture = loadFixtureKeys();

  function orderRef(merchantId: string, orderId: string): string {
    return `${merchantId}:${orderId}`;
  }

  /** Decrypt + verify + parse a request envelope. Throws NagadCryptoError. */
  function openEnvelope(
    app: AppRecord,
    body: { sensitiveData: string; signature: string },
  ): { plaintext: string; payload: Record<string, unknown> } {
    const plaintext = rsaDecrypt(fixture.privatePem, body.sensitiveData);
    const merchantKey = asString(app.credentials['merchant_public_key']);
    if (!rsaVerify(merchantKey, plaintext, body.signature)) {
      throw new NagadCryptoError(
        'Invalid signature: sign the exact plaintext JSON with the merchant private key.',
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(plaintext) as unknown;
    } catch {
      throw new NagadCryptoError('Decrypted sensitiveData is not valid JSON.');
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new NagadCryptoError('Decrypted sensitiveData must be a JSON object.');
    }
    return { plaintext, payload: payload as Record<string, unknown> };
  }

  /** Encrypt + sign a response object for the merchant. */
  function sealEnvelope(app: AppRecord, payload: Record<string, unknown>): Record<string, string> {
    const plaintext = JSON.stringify(payload);
    return {
      sensitiveData: rsaEncrypt(asString(app.credentials['merchant_public_key']), plaintext),
      signature: rsaSign(fixture.privatePem, plaintext),
    };
  }

  router.post(
    `${BASE}/check-out/initialize/:merchantId/:orderId`,
    async (req: Request, res: Response) => {
      const merchantId = asString(req.params['merchantId']);
      const orderId = asString(req.params['orderId']);
      if (!merchantId || !orderId || merchantId.length > 64 || orderId.length > 128) {
        res.status(400).json(fail('merchantId and orderId path params are required.'));
        return;
      }
      const app = await ctx.stores.findAppByStoreId(GATEWAY, 'merchant_id', merchantId);
      if (!app) {
        res.status(404).json(fail(`Unknown merchantId: ${merchantId}.`));
        return;
      }
      const parsed = InitBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json(
            fail(
              `Invalid request body: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}. Expected {dateTime, sensitiveData, signature}.`,
            ),
          );
        return;
      }
      let payload: Record<string, unknown>;
      try {
        payload = openEnvelope(app, parsed.data).payload;
      } catch (err) {
        if (err instanceof NagadCryptoError) {
          res.status(400).json(fail(err.message));
          return;
        }
        throw err;
      }
      const inner = InitPayloadSchema.safeParse(payload);
      if (
        !inner.success ||
        inner.data.merchantId !== merchantId ||
        inner.data.orderId !== orderId
      ) {
        res
          .status(400)
          .json(
            fail('Decrypted payload must be {merchantId, orderId, challenge} matching the path.'),
          );
        return;
      }
      const ref = orderRef(merchantId, orderId);
      const duplicate = await ctx.stores.findTransactionByGatewayTxnId(GATEWAY, ref, app.id);
      if (duplicate) {
        res.status(400).json(fail(`Duplicate orderId for merchant ${merchantId}: ${orderId}.`));
        return;
      }

      // Magic scenario marker lives in orderId (SIM:<name>[:suffix]).
      // Validated here (fail loud before any row); attached at complete.
      try {
        await ctx.engine.resolveForInit({
          workspaceId: app.workspaceId,
          gateway: GATEWAY,
          defaultScenarioId: app.defaultScenarioId,
          magicName: parseMagicScenario(orderId),
        });
      } catch (err) {
        if (err instanceof ScenarioNotFoundError) {
          res.status(400).json(fail(`Unknown scenario: ${err.scenarioName}.`));
          return;
        }
        throw err;
      }

      const paymentReferenceId = generatePaymentReferenceId();
      const challenge = generateChallenge();
      const txn = await ctx.stores.createTransaction({
        workspaceId: app.workspaceId,
        gatewayAppId: app.id,
        gateway: GATEWAY,
        state: 'initiated',
        gatewayTxnId: ref,
        gatewaySessionKey: paymentReferenceId,
        amountMinor: 0,
        currency: 'BDT',
        metadata: {
          merchantId,
          orderId,
          orderRef: ref,
          challenge,
          merchantCallbackURL: '',
          additionalMerchantInfo: {},
          amountKnown: false,
          initPayload: redactValue({ merchantId, orderId }),
        },
        expiresAt: new Date(ctx.clock.now(app.workspaceId).getTime() + 24 * 60 * 60 * 1000),
      });
      await ctx.stores.recordEvent({
        workspaceId: app.workspaceId,
        transactionId: txn.id,
        type: 'nagad.initialize.received',
        data: {
          http: {
            method: 'POST',
            path: `${BASE}/check-out/initialize/${merchantId}/${orderId}`,
            headers: redactHeaders(headersToRecord(req)),
            body: redactValue({ ...(req.body as Record<string, unknown>) }),
          },
          paymentReferenceId,
        },
      });
      ctx.logger.info('nagad payment initialized', { paymentReferenceId });
      const keys = realKeys(app);
      if (keys) {
        const real = await realInitialize(keys, txn);
        if (!real.ok) {
          await ctx.stores.transitionTransaction(
            txn.id,
            'failed',
            'nagad.sandbox.init_failed',
            { reason: real.reason },
            { sandboxMode: 'real' },
          );
          res.status(400).json(fail(`Nagad sandbox: ${real.reason}`));
          return;
        }
        await ctx.stores.transitionTransaction(
          txn.id,
          'initiated',
          'nagad.sandbox.initialized',
          { providerRef: real.ref, providerOrderId: providerOrderId(txn) },
          {
            sandboxMode: 'real',
            providerRef: real.ref,
            providerChallenge: real.challenge,
            providerOrderId: providerOrderId(txn),
            providerDateTime: real.dateTime,
          },
        );
        res.status(200).json(sealEnvelope(app, { paymentReferenceId, challenge }));
        return;
      }
      // Manual attach schedules the expiry timer; the real scenario (if any)
      // attaches at complete, when customer action becomes possible.
      await ctx.engine.attach({
        txn,
        scenarioId: null,
        definition: { name: 'manual', steps: [] },
        source: 'manual',
      });
      res.status(200).json(sealEnvelope(app, { paymentReferenceId, challenge }));
    },
  );

  router.post(
    `${BASE}/check-out/complete/:paymentReferenceId`,
    async (req: Request, res: Response) => {
      const paymentReferenceId = asString(req.params['paymentReferenceId']);
      if (!paymentReferenceId) {
        res.status(400).json(fail('paymentReferenceId path param is required.'));
        return;
      }
      const txn = await ctx.stores.findTransactionBySession(GATEWAY, paymentReferenceId);
      if (!txn) {
        res.status(404).json(fail(`Unknown paymentReferenceId: ${paymentReferenceId}.`));
        return;
      }
      if (txn.state !== 'initiated') {
        res.status(400).json(fail(`Payment is already ${txn.state}; complete runs once.`));
        return;
      }
      const app = await ctx.stores.getApp(txn.gatewayAppId);
      if (!app) {
        res.status(404).json(fail('Merchant app is missing.'));
        return;
      }
      const parsed = CompleteBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json(
            fail(
              'Invalid request body. Expected {dateTime, sensitiveData, signature, merchantCallbackURL, additionalMerchantInfo}.',
            ),
          );
        return;
      }
      let payload: Record<string, unknown>;
      try {
        payload = openEnvelope(app, parsed.data).payload;
      } catch (err) {
        if (err instanceof NagadCryptoError) {
          res.status(400).json(fail(err.message));
          return;
        }
        throw err;
      }
      const inner = CompletePayloadSchema.safeParse(payload);
      if (
        !inner.success ||
        inner.data.merchantId !== asString(txn.metadata['merchantId']) ||
        inner.data.orderId !== asString(txn.metadata['orderId']) ||
        inner.data.challenge !== asString(txn.metadata['challenge'])
      ) {
        res
          .status(400)
          .json(
            fail(
              'Decrypted payload must be {merchantId, orderId, amount, challenge} matching this payment.',
            ),
          );
        return;
      }
      const amount = parseAmountToMinor(inner.data.amount);
      if (!amount.ok) {
        res
          .status(400)
          .json(fail(`Invalid amount: ${inner.data.amount}. Use a decimal like "100.00".`));
        return;
      }
      if (!isAbsoluteHttpUrl(parsed.data.merchantCallbackURL)) {
        res.status(400).json(fail('merchantCallbackURL must be an absolute http(s) URL.'));
        return;
      }
      const additional =
        parsed.data.additionalMerchantInfo !== null &&
        typeof parsed.data.additionalMerchantInfo === 'object' &&
        !Array.isArray(parsed.data.additionalMerchantInfo)
          ? (parsed.data.additionalMerchantInfo as Record<string, unknown>)
          : {};

      // Resolve the scenario now (magic was validated at initialize); an
      // unknown name here means it vanished mid-flight — fail loud.
      let resolved;
      try {
        resolved = await ctx.engine.resolveForInit({
          workspaceId: txn.workspaceId,
          gateway: GATEWAY,
          defaultScenarioId: app.defaultScenarioId,
          magicName: parseMagicScenario(asString(txn.metadata['orderId'])),
        });
      } catch (err) {
        if (err instanceof ScenarioNotFoundError) {
          res.status(400).json(fail(`Unknown scenario: ${err.scenarioName}.`));
          return;
        }
        throw err;
      }

      await ctx.stores.setTransactionAmount(txn.id, amount.minor, {
        merchantCallbackURL: parsed.data.merchantCallbackURL,
        additionalMerchantInfo: additional,
        amountKnown: true,
      });
      const updated = await ctx.stores.transitionTransaction(
        txn.id,
        'checkout',
        'nagad.complete.received',
        {
          http: {
            method: 'POST',
            path: `${BASE}/check-out/complete/${paymentReferenceId}`,
            headers: redactHeaders(headersToRecord(req)),
            body: redactValue({ ...(req.body as Record<string, unknown>) }),
          },
          paymentReferenceId,
          amountMinor: amount.minor,
        },
      );
      if (updated.metadata['sandboxMode'] === 'real') {
        const keys = realKeys(app);
        const real = keys
          ? await realComplete(
              keys,
              updated,
              amount.minor,
              `${ctx.simBaseUrl}/nagad/sandbox/callback/${updated.id}`,
            )
          : ({ ok: false, reason: 'real-sandbox keys were removed' } as const);
        if (!real.ok) {
          await ctx.stores.transitionTransaction(
            updated.id,
            'failed',
            'nagad.sandbox.complete_failed',
            {
              reason: real.reason,
            },
          );
          res.status(400).json(fail(`Nagad sandbox: ${real.reason}`));
          return;
        }
        await ctx.stores.recordEvent({
          workspaceId: updated.workspaceId,
          transactionId: updated.id,
          type: 'nagad.sandbox.completed',
          data: { callBackUrl: real.callBackUrl },
        });
        res.status(200).json({ callBackUrl: real.callBackUrl, status: 'Success' });
        return;
      }
      await ctx.engine.attach({
        txn: updated,
        scenarioId: resolved.scenarioId,
        definition: resolved.definition,
        source: resolved.source,
      });
      res.status(200).json({
        callBackUrl: `${ctx.simBaseUrl}/nagad/checkout?paymentRefId=${paymentReferenceId}`,
        status: 'Success',
      });
    },
  );

  router.get(`${BASE}/verify/payment/:paymentReferenceId`, async (req: Request, res: Response) => {
    const paymentReferenceId = asString(req.params['paymentReferenceId']);
    if (!paymentReferenceId) {
      res.status(400).json(fail('paymentReferenceId path param is required.'));
      return;
    }
    const txn = await ctx.stores.findTransactionBySession(GATEWAY, paymentReferenceId);
    if (!txn) {
      res.status(404).json(fail(`Unknown paymentReferenceId: ${paymentReferenceId}.`));
      return;
    }
    const status = verifyStatusFor(
      txn.state as 'initiated' | 'checkout' | 'success' | 'failed' | 'cancelled' | 'expired',
    );
    await ctx.stores.recordEvent({
      workspaceId: txn.workspaceId,
      transactionId: txn.id,
      type: 'nagad.verify.checked',
      data: { paymentReferenceId, status },
    });
    const ledger = refundLedger(txn);
    // Response shape is simulator-invented (no source shows it); only the
    // status vocabulary is community-sourced.
    res.status(200).json({
      paymentReferenceId,
      orderId: asString(txn.metadata['orderId']),
      merchantId: asString(txn.metadata['merchantId']),
      amount: formatAmountMinor(txn.amountMinor),
      currency: txn.currency,
      status,
      ...(txn.metadata['trxId'] ? { trxId: asString(txn.metadata['trxId']) } : {}),
      ...(ledger.refunds.length > 0
        ? {
            refundedAmount: formatAmountMinor(ledger.refundedMinor),
            refundStatus: ledger.refundStatus,
          }
        : {}),
    });
  });

  router.get('/nagad/checkout', async (req: Request, res: Response) => {
    const paymentRefId = firstQueryParam(req.query['paymentRefId']);
    if (!paymentRefId) {
      res
        .status(400)
        .send(errorPage('Missing payment', 'paymentRefId query param is required.', 400));
      return;
    }
    const txn = await ctx.stores.findTransactionBySession(GATEWAY, paymentRefId);
    if (!txn) {
      res
        .status(404)
        .send(errorPage('Unknown payment', 'No transaction for this paymentRefId.', 404));
      return;
    }
    await ctx.stores.recordEvent({
      workspaceId: txn.workspaceId,
      transactionId: txn.id,
      type: 'nagad.checkout.viewed',
      data: { paymentRefId },
    });
    res.status(200).send(
      checkoutPage({
        paymentRefId,
        amount: formatAmountMinor(txn.amountMinor),
        orderId: asString(txn.metadata['orderId']),
        appName: appName(await ctx.stores.getApp(txn.gatewayAppId)),
        state: txn.state,
      }),
    );
  });

  router.post('/nagad/checkout', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const paymentRefId =
      asString(body['paymentRefId']) || firstQueryParam(req.query['paymentRefId']);
    const action = asString(body['action']);
    if (paymentRefId && action === '' && typeof body['step'] === 'string') {
      // Wallet step advance (number -> OTP -> PIN). Nothing is stored.
      const stepTxn = await ctx.stores.findTransactionBySession(GATEWAY, paymentRefId);
      if (!stepTxn) {
        res
          .status(404)
          .send(errorPage('Unknown payment', 'No transaction for this paymentRefId.', 404));
        return;
      }
      const next = nextWalletStep(body);
      const stepApp = await ctx.stores.getApp(stepTxn.gatewayAppId);
      res.status(200).send(
        checkoutPage({
          paymentRefId,
          amount: formatAmountMinor(stepTxn.amountMinor),
          orderId: asString(stepTxn.metadata['orderId']),
          appName: appName(stepApp),
          state: stepTxn.state,
          step: next.step,
          wallet: next.wallet,
          ...(next.error ? { error: next.error } : {}),
        }),
      );
      return;
    }
    if (!paymentRefId || !(CHECKOUT_ACTIONS as readonly string[]).includes(action)) {
      res
        .status(400)
        .send(
          errorPage(
            'Invalid checkout action',
            'paymentRefId and action=success|fail|cancel are required.',
            400,
          ),
        );
      return;
    }
    const txn = await ctx.stores.findTransactionBySession(GATEWAY, paymentRefId);
    if (!txn) {
      res
        .status(404)
        .send(errorPage('Unknown payment', 'No transaction for this paymentRefId.', 404));
      return;
    }
    const app = await ctx.stores.getApp(txn.gatewayAppId);
    if (txn.state !== 'checkout') {
      res.status(200).send(
        checkoutPage({
          paymentRefId,
          amount: formatAmountMinor(txn.amountMinor),
          orderId: asString(txn.metadata['orderId']),
          appName: appName(app),
          state: txn.state,
          notice: `This payment is already ${txn.state}; the outcome was not changed.`,
        }),
      );
      return;
    }
    const outcome = action as CheckoutAction;
    const { status, targetUrl } = await completeCheckout({ ctx, txn, outcome });
    res.status(200).send(redirectPage({ status, paymentRefId, targetUrl }));
  });

  router.get('/nagad/sandbox/callback/:txnId', async (req: Request, res: Response) => {
    const txnId = asString(req.params['txnId']);
    const txn = /^[A-Za-z0-9-]{1,64}$/.test(txnId) ? await ctx.stores.getTransaction(txnId) : null;
    if (!txn || txn.gateway !== GATEWAY || txn.metadata['sandboxMode'] !== 'real') {
      res.status(404).send(errorPage('Unknown payment', 'No real-sandbox payment here.', 404));
      return;
    }
    const reported = asString(firstQueryParam(req.query['status']));
    await ctx.stores.recordEvent({
      workspaceId: txn.workspaceId,
      transactionId: txn.id,
      type: 'nagad.sandbox.callback',
      data: {
        status: reported,
        payment_ref_id: asString(firstQueryParam(req.query['payment_ref_id'])),
      },
    });
    const paymentRefId = txn.gatewaySessionKey ?? '';
    if (txn.state !== 'checkout') {
      const status =
        txn.state === 'success' ? 'Success' : txn.state === 'cancelled' ? 'Cancel' : 'Fail';
      const targetUrl = buildCallbackUrl(asString(txn.metadata['merchantCallbackURL']), {
        merchant: asString(txn.metadata['merchantId']),
        orderId: asString(txn.metadata['orderId']),
        paymentRefId,
        status,
      });
      res.status(200).send(redirectPage({ status, paymentRefId, targetUrl }));
      return;
    }
    // Never trust the redirect: ask Nagad's verify API.
    let outcome: CheckoutAction = /abort|cancel/i.test(reported) ? 'cancel' : 'fail';
    let trxId = '';
    try {
      const v = await realVerify(asString(txn.metadata['providerRef']));
      await ctx.stores.recordEvent({
        workspaceId: txn.workspaceId,
        transactionId: txn.id,
        type: 'nagad.sandbox.verified',
        data: v.raw,
      });
      if (v.status === 'Success' && v.amountMinor === txn.amountMinor) {
        outcome = 'success';
        trxId = v.issuerPaymentRefNo;
      } else if (/abort|cancel/i.test(v.status)) {
        outcome = 'cancel';
      }
    } catch (err) {
      ctx.logger.warn('nagad sandbox verify failed', { error: String(err) });
    }
    const done = await completeCheckout({
      ctx,
      txn,
      outcome,
      ...(trxId ? { providerTrxId: trxId } : {}),
    });
    res
      .status(200)
      .send(redirectPage({ status: done.status, paymentRefId, targetUrl: done.targetUrl }));
  });

  mountNagadRefundRoutes(router, ctx, BASE, { open: openEnvelope, seal: sealEnvelope, fail });

  return router;
}
