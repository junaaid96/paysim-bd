import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { rsaDecrypt, rsaEncrypt, rsaSign, rsaVerify } from '../src/crypto.js';
import { loadFixtureKeys } from '../src/fixtures.js';
import { createNagadRouter } from '../src/routes.js';
import { makeCtx, type FakeContext } from './fakes.js';

const BASE = '/remote-payment-gateway-1.0/api/dfs';
const MERCHANT_ID = 'SIM-MERCHANT-001';
const fixture = loadFixtureKeys();

function seal(payload: Record<string, unknown>): Record<string, string> {
  const plaintext = JSON.stringify(payload);
  return {
    dateTime: '20260101120000',
    sensitiveData: rsaEncrypt(fixture.publicPem, plaintext),
    signature: rsaSign(fixture.merchantPrivatePem, plaintext),
  };
}
function open(body: { sensitiveData: string; signature: string }): Record<string, unknown> {
  const plaintext = rsaDecrypt(fixture.merchantPrivatePem, body.sensitiveData);
  expect(rsaVerify(fixture.publicPem, plaintext, body.signature)).toBe(true);
  return JSON.parse(plaintext) as Record<string, unknown>;
}

describe('nagad refund API', () => {
  let fakes: FakeContext;
  let app: express.Application;
  let n = 0;

  beforeEach(() => {
    fakes = makeCtx();
    fakes.stores.seedApp();
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use(createNagadRouter(fakes.ctx));
  });

  async function paid(action = 'success'): Promise<string> {
    n += 1;
    const orderId = `ORD-R${n}`;
    const init = await request(app)
      .post(`${BASE}/check-out/initialize/${MERCHANT_ID}/${orderId}`)
      .send(seal({ merchantId: MERCHANT_ID, orderId, challenge: 'a'.repeat(40) }));
    const opened = open(init.body);
    const ref = String(opened['paymentReferenceId']);
    await request(app)
      .post(`${BASE}/check-out/complete/${ref}`)
      .send({
        ...seal({
          merchantId: MERCHANT_ID,
          orderId,
          amount: '300.00',
          challenge: opened['challenge'],
        }),
        merchantCallbackURL: 'https://merchant.test/cb',
        additionalMerchantInfo: {},
      });
    await request(app).post('/nagad/checkout').type('form').send({ paymentRefId: ref, action });
    return ref;
  }

  function refund(ref: string, cancelAmount: string, referenceNo: string, referenceMessage = 'r') {
    return request(app)
      .post(`${BASE}/check-out/refund/${MERCHANT_ID}`)
      .send(
        seal({
          merchantId: MERCHANT_ID,
          paymentRefId: ref,
          originalRequestDate: '20260101',
          originalAmount: '300.00',
          cancelAmount,
          referenceNo,
          referenceMessage,
        }),
      );
  }

  it('refunds with sealed envelopes, partial then full, idempotent on referenceNo', async () => {
    const ref = await paid();
    const a = await refund(ref, '100.00', 'REF-1');
    expect(a.status).toBe(200);
    expect(open(a.body)).toMatchObject({
      status: 'Success',
      cancelAmount: '100.00',
      refundStatus: 'partial',
    });
    const again = await refund(ref, '100.00', 'REF-1');
    expect(open(again.body)['cancelTrxId']).toBe(open(a.body)['cancelTrxId']);
    const over = await refund(ref, '250.00', 'REF-2');
    expect(over.status).toBe(400);
    const rest = await refund(ref, '200.00', 'REF-3');
    expect(open(rest.body)).toMatchObject({
      status: 'Success',
      refundStatus: 'full',
      refundedAmount: '300.00',
    });
    const verify = await request(app).get(`${BASE}/verify/payment/${ref}`);
    expect(verify.body).toMatchObject({ status: 'Success', refundStatus: 'full' });
  });

  it('declines on the marker and refuses unpaid payments', async () => {
    const ref = await paid();
    const declined = await refund(ref, '10.00', 'REF-X', 'SIM:refund_fail');
    expect(open(declined.body)['status']).toBe('Failed');
    const unpaid = await paid('cancel');
    const res = await refund(unpaid, '10.00', 'REF-Y');
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/completed/);
  });
});
