import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { REDACTED } from '@paysim/core';

import { rsaDecrypt, rsaEncrypt, rsaSign, rsaVerify } from '../src/crypto.js';
import { loadFixtureKeys } from '../src/fixtures.js';
import { createNagadRouter } from '../src/routes.js';
import { makeCtx, type FakeContext } from './fakes.js';

const GATEWAY_BASE = '/remote-payment-gateway-1.0/api/dfs';
const MERCHANT_ID = 'SIM-MERCHANT-001';
const fixture = loadFixtureKeys();

/** Merchant-side crypto: seal a request, open a sim response. */
function sealRequest(payload: Record<string, unknown>): {
  dateTime: string;
  sensitiveData: string;
  signature: string;
} {
  const plaintext = JSON.stringify(payload);
  return {
    dateTime: '20260101120000',
    sensitiveData: rsaEncrypt(fixture.publicPem, plaintext),
    signature: rsaSign(fixture.merchantPrivatePem, plaintext),
  };
}

function openResponse(body: { sensitiveData: string; signature: string }): Record<string, unknown> {
  const plaintext = rsaDecrypt(fixture.merchantPrivatePem, body.sensitiveData);
  expect(rsaVerify(fixture.publicPem, plaintext, body.signature)).toBe(true);
  return JSON.parse(plaintext) as Record<string, unknown>;
}

describe('nagad routes', () => {
  let fakes: FakeContext;
  let app: express.Application;
  let order = 0;

  beforeEach(() => {
    fakes = makeCtx();
    fakes.stores.seedApp();
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use(createNagadRouter(fakes.ctx));
  });

  async function initialize(
    orderId?: string,
  ): Promise<{ paymentReferenceId: string; challenge: string }> {
    order += 1;
    const id = orderId ?? `ORDER-${order}`;
    const res = await request(app)
      .post(`${GATEWAY_BASE}/check-out/initialize/${MERCHANT_ID}/${id}`)
      .send(sealRequest({ merchantId: MERCHANT_ID, orderId: id, challenge: 'a'.repeat(40) }));
    expect(res.status).toBe(200);
    const opened = openResponse(res.body as { sensitiveData: string; signature: string });
    return {
      paymentReferenceId: String(opened['paymentReferenceId']),
      challenge: String(opened['challenge']),
    };
  }

  async function complete(
    paymentReferenceId: string,
    orderId: string,
    challenge: string,
    amount = '100.00',
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await request(app)
      .post(`${GATEWAY_BASE}/check-out/complete/${paymentReferenceId}`)
      .send({
        ...sealRequest({ merchantId: MERCHANT_ID, orderId, amount, challenge }),
        merchantCallbackURL: 'https://merchant.test/cb',
        additionalMerchantInfo: {},
      });
    return { status: res.status, body: res.body as Record<string, unknown> };
  }

  it('initializes with mutual crypto and redacts the envelope', async () => {
    const { paymentReferenceId, challenge } = await initialize('ORDER-1');
    expect(paymentReferenceId).toMatch(/^SIMREF[A-Z0-9]{16}$/);
    expect(challenge).toMatch(/^[a-z]{40}$/);

    const txn = await fakes.stores.findTransactionBySession('nagad', paymentReferenceId);
    expect(txn?.state).toBe('initiated');
    expect(txn?.amountMinor).toBe(0);
    expect(txn?.gatewayTxnId).toBe(`${MERCHANT_ID}:ORDER-1`);
    // Manual attach at initialize schedules the expiry timer only.
    expect(fakes.attached).toHaveLength(1);
    expect(fakes.attached[0]).toMatchObject({ source: 'manual' });

    const event = fakes.stores.events.find((e) => e.type === 'nagad.initialize.received');
    const body = (event?.data['http'] as { body: Record<string, unknown> })?.body;
    expect(body['sensitiveData']).toBe(REDACTED);
    expect(body['signature']).toBe(REDACTED);
  });

  it('rejects bad crypto, mismatches and duplicates loudly', async () => {
    await initialize('ORDER-DUP');
    const dup = await request(app)
      .post(`${GATEWAY_BASE}/check-out/initialize/${MERCHANT_ID}/ORDER-DUP`)
      .send(
        sealRequest({ merchantId: MERCHANT_ID, orderId: 'ORDER-DUP', challenge: 'b'.repeat(40) }),
      );
    expect(dup.status).toBe(400);
    expect(String(dup.body.message)).toContain('Duplicate orderId');

    const unknownMerchant = await request(app)
      .post(`${GATEWAY_BASE}/check-out/initialize/NOPE/ORDER-X`)
      .send(sealRequest({ merchantId: 'NOPE', orderId: 'ORDER-X', challenge: 'b'.repeat(40) }));
    expect(unknownMerchant.status).toBe(404);

    const badSig = await request(app)
      .post(`${GATEWAY_BASE}/check-out/initialize/${MERCHANT_ID}/ORDER-BS`)
      .send({
        ...sealRequest({ merchantId: MERCHANT_ID, orderId: 'ORDER-BS', challenge: 'b'.repeat(40) }),
        signature: rsaSign(fixture.merchantPrivatePem, '{"tampered":true}'),
      });
    expect(badSig.status).toBe(400);
    expect(String(badSig.body.message)).toContain('Invalid signature');

    const garbage = await request(app)
      .post(`${GATEWAY_BASE}/check-out/initialize/${MERCHANT_ID}/ORDER-GC`)
      .send({ dateTime: '20260101120000', sensitiveData: '!!!', signature: 'AAA' });
    expect(garbage.status).toBe(400);

    const mismatch = await request(app)
      .post(`${GATEWAY_BASE}/check-out/initialize/${MERCHANT_ID}/ORDER-MM`)
      .send(sealRequest({ merchantId: MERCHANT_ID, orderId: 'OTHER', challenge: 'b'.repeat(40) }));
    expect(mismatch.status).toBe(400);
    expect(String(mismatch.body.message)).toContain('matching the path');

    const badDate = await request(app)
      .post(`${GATEWAY_BASE}/check-out/initialize/${MERCHANT_ID}/ORDER-BD`)
      .send({
        ...sealRequest({ merchantId: MERCHANT_ID, orderId: 'ORDER-BD', challenge: 'x' }),
        dateTime: 'yesterday',
      });
    expect(badDate.status).toBe(400);
  });

  it('completes with the echoed challenge and hands out the mock page', async () => {
    const { paymentReferenceId, challenge } = await initialize('ORDER-C1');
    const res = await complete(paymentReferenceId, 'ORDER-C1', challenge, '150.75');
    expect(res.status).toBe(200);
    expect(res.body['status']).toBe('Success');
    expect(String(res.body['callBackUrl'])).toContain(
      `/nagad/checkout?paymentRefId=${paymentReferenceId}`,
    );

    const txn = await fakes.stores.findTransactionBySession('nagad', paymentReferenceId);
    expect(txn?.state).toBe('checkout');
    expect(txn?.amountMinor).toBe(15075);
    // Real scenario attaches at complete.
    expect(fakes.attached).toHaveLength(2);

    // Complete runs once.
    const again = await complete(paymentReferenceId, 'ORDER-C1', challenge);
    expect(again.status).toBe(400);
  });

  it('rejects complete mismatches loudly', async () => {
    const { paymentReferenceId, challenge } = await initialize('ORDER-C2');
    const wrongChallenge = await complete(paymentReferenceId, 'ORDER-C2', 'z'.repeat(40));
    expect(wrongChallenge.status).toBe(400);
    const badAmount = await complete(paymentReferenceId, 'ORDER-C2', challenge, 'free');
    expect(badAmount.status).toBe(400);
    const unknown = await request(app)
      .post(`${GATEWAY_BASE}/check-out/complete/SIMREFNOPE0000000000`)
      .send({
        ...sealRequest({ merchantId: MERCHANT_ID, orderId: 'ORDER-C2', amount: '1.00', challenge }),
        merchantCallbackURL: 'https://merchant.test/cb',
        additionalMerchantInfo: {},
      });
    expect(unknown.status).toBe(404);
  });

  it('serves the mock page and settles with GET redirects (no server POST)', async () => {
    const { paymentReferenceId, challenge } = await initialize('ORDER-M1');
    await complete(paymentReferenceId, 'ORDER-M1', challenge);

    const page = await request(app).get(`/nagad/checkout?paymentRefId=${paymentReferenceId}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('SIMULATOR');
    expect(page.text).toContain('ORDER-M1');

    const res = await request(app)
      .post('/nagad/checkout')
      .type('form')
      .send({ paymentRefId: paymentReferenceId, action: 'success' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('payment_ref_id=' + paymentReferenceId);
    expect(res.text).toContain('order_id=ORDER-M1');
    expect(res.text).toContain('status=Success');
    expect(res.text).toContain('id="continue"');
    expect(fakes.delivered).toHaveLength(0);

    const verify = await request(app).get(`${GATEWAY_BASE}/verify/payment/${paymentReferenceId}`);
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ status: 'Success', amount: '100.00', currency: 'BDT' });
    expect(String(verify.body['trxId'])).toMatch(/^SIMTRX[0-9A-F]{10}$/);

    // Idempotent reclick.
    const again = await request(app)
      .post('/nagad/checkout')
      .type('form')
      .send({ paymentRefId: paymentReferenceId, action: 'success' });
    expect(again.text).toContain('already success');
  });

  it('maps fail/cancel/pending to the community verify vocabulary', async () => {
    const failCase = await initialize('ORDER-F1');
    await complete(failCase.paymentReferenceId, 'ORDER-F1', failCase.challenge);
    await request(app)
      .post('/nagad/checkout')
      .type('form')
      .send({ paymentRefId: failCase.paymentReferenceId, action: 'fail' });
    const failed = await request(app).get(
      `${GATEWAY_BASE}/verify/payment/${failCase.paymentReferenceId}`,
    );
    expect(failed.body['status']).toBe('FAIL');

    const cancelCase = await initialize('ORDER-X1');
    await complete(cancelCase.paymentReferenceId, 'ORDER-X1', cancelCase.challenge);
    const cancelRes = await request(app)
      .post('/nagad/checkout')
      .type('form')
      .send({ paymentRefId: cancelCase.paymentReferenceId, action: 'cancel' });
    expect(cancelRes.text).toContain('status=Cancel');
    const cancelled = await request(app).get(
      `${GATEWAY_BASE}/verify/payment/${cancelCase.paymentReferenceId}`,
    );
    expect(cancelled.body['status']).toBe('ABORTED');

    const pendingCase = await initialize('ORDER-P1');
    const pending = await request(app).get(
      `${GATEWAY_BASE}/verify/payment/${pendingCase.paymentReferenceId}`,
    );
    expect(pending.body['status']).toBe('PENDING');

    const unknown = await request(app).get(`${GATEWAY_BASE}/verify/payment/SIMREFNOPE0000000000`);
    expect(unknown.status).toBe(404);
  });
});
