// Nagad checkout flow against the live stack (router + engine +
// scheduler + real Postgres). Needs TEST_DATABASE_URL (serial).

import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  loadFixtureKeys,
  nagadPlugin,
  rsaDecrypt,
  rsaEncrypt,
  rsaSign,
  rsaVerify,
} from '@paysim/gateway-nagad';

import { createTestHost, type TestHost } from './host-harness.js';

const TEST_URL = process.env['TEST_DATABASE_URL'];
const maybe = TEST_URL ? describe : describe.skip;

const GATEWAY_BASE = '/remote-payment-gateway-1.0/api/dfs';
const MERCHANT_ID = 'SIM-MERCHANT-001';
const CALLBACK_URL = 'https://merchant.test/cb';
const fixture = loadFixtureKeys();

function sealRequest(payload: Record<string, unknown>): Record<string, string> {
  const plaintext = JSON.stringify(payload);
  return {
    dateTime: '20260101120000',
    sensitiveData: rsaEncrypt(fixture.publicPem, plaintext),
    signature: rsaSign(fixture.merchantPrivatePem, plaintext),
  };
}

function openInitialize(body: Record<string, unknown>): {
  paymentReferenceId: string;
  challenge: string;
} {
  const plaintext = rsaDecrypt(fixture.merchantPrivatePem, String(body['sensitiveData']));
  expect(rsaVerify(fixture.publicPem, plaintext, String(body['signature']))).toBe(true);
  const parsed = JSON.parse(plaintext) as Record<string, unknown>;
  return {
    paymentReferenceId: String(parsed['paymentReferenceId']),
    challenge: String(parsed['challenge']),
  };
}

maybe('nagad flow integration', () => {
  let host: TestHost;
  let app: express.Application;
  let order = 0;

  beforeAll(async () => {
    host = await createTestHost();
    await host.queries.createApp({
      workspaceId: host.workspace.id,
      gateway: 'nagad',
      name: 'Nagad test merchant',
      credentials: {
        merchant_id: MERCHANT_ID,
        merchant_number: '01700000000',
        merchant_public_key: fixture.merchantPublicPem,
      },
    });
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use(nagadPlugin.createRouter(host.ctx) as unknown as express.Router);
  }, 60_000);

  afterAll(async () => {
    await host.cleanup();
  });

  async function start(
    orderId?: string,
  ): Promise<{ orderId: string; paymentReferenceId: string; challenge: string }> {
    order += 1;
    const id = orderId ?? `ORDER-FLOW-${order}`;
    const res = await request(app)
      .post(`${GATEWAY_BASE}/check-out/initialize/${MERCHANT_ID}/${id}`)
      .send(sealRequest({ merchantId: MERCHANT_ID, orderId: id, challenge: 'a'.repeat(40) }));
    expect(res.status).toBe(200);
    const opened = openInitialize(res.body as Record<string, unknown>);
    return { orderId: id, ...opened };
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
        merchantCallbackURL: CALLBACK_URL,
        additionalMerchantInfo: {},
      });
    return { status: res.status, body: res.body as Record<string, unknown> };
  }

  it('completes initialize → complete → mock page → verify', async () => {
    const started = await start();
    expect(started.paymentReferenceId).toMatch(/^SIMREF[A-Z0-9]{16}$/);

    const pending = await request(app).get(
      `${GATEWAY_BASE}/verify/payment/${started.paymentReferenceId}`,
    );
    expect(pending.body).toMatchObject({ status: 'PENDING' });

    const done = await complete(
      started.paymentReferenceId,
      started.orderId,
      started.challenge,
      '150.75',
    );
    expect(done.status).toBe(200);
    expect(String(done.body['callBackUrl'])).toContain(
      `/nagad/checkout?paymentRefId=${started.paymentReferenceId}`,
    );

    const page = await request(app).get(
      `/nagad/checkout?paymentRefId=${started.paymentReferenceId}`,
    );
    expect(page.status).toBe(200);
    expect(page.text).toContain('PaySim sandbox — test only, no real money');

    const settled = await request(app)
      .post('/nagad/checkout')
      .type('form')
      .send({ paymentRefId: started.paymentReferenceId, action: 'success' });
    expect(settled.text).toContain('status=Success');
    expect(settled.text).toContain(`order_id=${started.orderId}`);

    const verified = await request(app).get(
      `${GATEWAY_BASE}/verify/payment/${started.paymentReferenceId}`,
    );
    expect(verified.body).toMatchObject({
      status: 'Success',
      amount: '150.75',
      currency: 'BDT',
      orderId: started.orderId,
    });
    expect(String(verified.body['trxId'])).toMatch(/^SIMTRX[0-9A-F]{10}$/);
  });

  it('fails through the mock page and rejects duplicate order ids', async () => {
    const started = await start();
    await complete(started.paymentReferenceId, started.orderId, started.challenge);

    const failed = await request(app)
      .post('/nagad/checkout')
      .type('form')
      .send({ paymentRefId: started.paymentReferenceId, action: 'fail' });
    expect(failed.text).toContain('status=Fail');

    const verified = await request(app).get(
      `${GATEWAY_BASE}/verify/payment/${started.paymentReferenceId}`,
    );
    expect(verified.body).toMatchObject({ status: 'FAIL' });

    const duplicate = await request(app)
      .post(`${GATEWAY_BASE}/check-out/initialize/${MERCHANT_ID}/${started.orderId}`)
      .send(
        sealRequest({
          merchantId: MERCHANT_ID,
          orderId: started.orderId,
          challenge: 'b'.repeat(40),
        }),
      );
    expect(duplicate.status).toBe(400);
  });

  it('settles through SIM: magic attached at complete', async () => {
    const started = await start('SIM:immediate-success');
    const done = await complete(started.paymentReferenceId, started.orderId, started.challenge);
    expect(done.status).toBe(200);

    // The zero-delay step runs through the engine's job queue; poll verify.
    const deadline = Date.now() + 10_000;
    let status = 'PENDING';
    while (Date.now() < deadline && status === 'PENDING') {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const verified = await request(app).get(
        `${GATEWAY_BASE}/verify/payment/${started.paymentReferenceId}`,
      );
      status = String(verified.body['status']);
    }
    expect(status).toBe('Success');
  });

  it('rejects unknown SIM: names at initialize without writing rows', async () => {
    const res = await request(app)
      .post(`${GATEWAY_BASE}/check-out/initialize/${MERCHANT_ID}/SIM:nope`)
      .send(
        sealRequest({ merchantId: MERCHANT_ID, orderId: 'SIM:nope', challenge: 'c'.repeat(40) }),
      );
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('Unknown scenario: nope');
  });
});
