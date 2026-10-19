// bKash tokenized-checkout flow against the live stack (router + engine +
// scheduler + real Postgres). Needs TEST_DATABASE_URL (serial).

import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bkashPlugin } from '@paysim/gateway-bkash';

import { createTestHost, type TestHost } from './host-harness.js';

const TEST_URL = process.env['TEST_DATABASE_URL'];
const maybe = TEST_URL ? describe : describe.skip;

const CREATE = {
  payerReference: 'TEST001ABC',
  callbackURL: 'https://merchant.test/cb',
  amount: '150.75',
  currency: 'BDT',
  intent: 'sale',
  merchantInvoiceNumber: 'INV-FLOW-1',
};

maybe('bkash flow integration', () => {
  let host: TestHost;
  let app: express.Application;
  let token: string;
  let invoice = 0;

  beforeAll(async () => {
    host = await createTestHost();
    await host.queries.createApp({
      workspaceId: host.workspace.id,
      gateway: 'bkash',
      name: 'bKash test merchant',
      credentials: {
        app_key: 'sim-app-key',
        app_secret: 'sim-app-secret-key',
        username: 'sim-merchant',
        password: 'sim-merchant-password',
      },
    });
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use(bkashPlugin.createRouter(host.ctx) as unknown as express.Router);
    const granted = await request(app)
      .post('/v2/tokenized-checkout/auth/grant-token')
      .set({ username: 'sim-merchant', password: 'sim-merchant-password' })
      .send({ app_key: 'sim-app-key', app_secret: 'sim-app-secret-key' });
    expect(granted.body.statusCode).toBe('0000');
    token = String(granted.body.id_token);
  }, 60_000);

  afterAll(async () => {
    await host.cleanup();
  });

  function headers(): Record<string, string> {
    return { authorization: token, 'x-app-key': 'sim-app-key' };
  }

  async function create(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    invoice += 1;
    const res = await request(app)
      .post('/v2/tokenized-checkout/payment/create')
      .set(headers())
      .send({ ...CREATE, merchantInvoiceNumber: `INV-FLOW-${invoice}`, ...overrides });
    expect(res.status).toBe(200);
    return res.body as Record<string, unknown>;
  }

  async function query(paymentId: string): Promise<Record<string, unknown>> {
    const res = await request(app)
      .post('/v2/tokenized-checkout/query/payment')
      .set(headers())
      .send({ paymentId });
    expect(res.status).toBe(200);
    return res.body as Record<string, unknown>;
  }

  async function execute(paymentId: string): Promise<Record<string, unknown>> {
    const res = await request(app)
      .post('/v2/tokenized-checkout/payment/execute')
      .set(headers())
      .send({ paymentId });
    expect(res.status).toBe(200);
    return res.body as Record<string, unknown>;
  }

  it('completes grant → create → verify → execute → query', async () => {
    const created = await create();
    expect(created['transactionStatus']).toBe('Initiated');
    const paymentId = String(created['paymentId']);
    expect(paymentId).toMatch(/^TR0011[0-9A-Za-z]{7}\d{13}$/);

    const fresh = await query(paymentId);
    expect(fresh).toMatchObject({
      transactionStatus: 'Initiated',
      verificationStatus: 'Incomplete',
    });

    const page = await request(app).get(`/bkash/checkout?paymentId=${paymentId}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('SIMULATOR');

    const early = await execute(paymentId);
    expect(early['externalCode']).toBe('2060');

    const verified = await request(app)
      .post('/bkash/checkout')
      .type('form')
      .send({ paymentId, action: 'success' });
    expect(verified.text).toContain('status=success');

    const checked = await query(paymentId);
    expect(checked).toMatchObject({
      transactionStatus: 'Initiated',
      verificationStatus: 'Complete',
    });

    const done = await execute(paymentId);
    expect(done).toMatchObject({ transactionStatus: 'Completed' });
    expect(String(done['trxId'])).toMatch(/^[A-Z0-9]{9}$/);

    const completed = await query(paymentId);
    expect(completed).toMatchObject({
      transactionStatus: 'Completed',
      verificationStatus: 'Complete',
    });

    const again = await execute(paymentId);
    expect(again).toMatchObject({
      externalCode: '2062',
      internalCode: 'payment_already_completed',
    });
  });

  it('fails verification through the mock page, blocking execute', async () => {
    const created = await create();
    const paymentId = String(created['paymentId']);
    const res = await request(app)
      .post('/bkash/checkout')
      .type('form')
      .send({ paymentId, action: 'fail' });
    expect(res.text).toContain('status=failure');

    const checked = await query(paymentId);
    expect(checked).toMatchObject({
      transactionStatus: 'Initiated',
      verificationStatus: 'Incomplete',
    });
    const done = await execute(paymentId);
    expect(done['externalCode']).toBe('2056');
  });

  it('drives verification with zero browser clicks via SIM:', async () => {
    const created = await create({ merchantInvoiceNumber: 'SIM:immediate-success' });
    const paymentId = String(created['paymentId']);
    await host.waitFor(async () => {
      const checked = await query(paymentId);
      return checked['verificationStatus'] === 'Complete';
    }, 'scenario to verify');
    const done = await execute(paymentId);
    expect(done['transactionStatus']).toBe('Completed');
  });

  it('fails creates loudly on unknown SIM: names', async () => {
    const body = await create({ merchantInvoiceNumber: 'SIM:nope' });
    expect(body['externalCode']).toBe('2003');
    expect(String(body['errorMessageEn'])).toContain('Unknown scenario: nope');
  });

  it('expires id_tokens on the fake clock', async () => {
    try {
      await host.jumpClock(3_601_000);
      const res = await request(app)
        .post('/v2/tokenized-checkout/query/payment')
        .set(headers())
        .send({ paymentId: 'TR0011XXXXXXX0000000000000' });
      expect(res.body['externalCode']).toBe('2003');
    } finally {
      await host.resetClock();
    }
    // A fresh grant works after the jump back.
    const granted = await request(app)
      .post('/v2/tokenized-checkout/auth/grant-token')
      .set({ username: 'sim-merchant', password: 'sim-merchant-password' })
      .send({ app_key: 'sim-app-key', app_secret: 'sim-app-secret-key' });
    expect(granted.body.statusCode).toBe('0000');
    token = String(granted.body.id_token);
  });

  it('expires unexecuted payments past the 24h validity', async () => {
    const created = await create();
    const paymentId = String(created['paymentId']);
    try {
      await host.jumpClock(24 * 3_600_000 + 1000);
      // The jump expired the id_token too — re-grant before querying.
      const granted = await request(app)
        .post('/v2/tokenized-checkout/auth/grant-token')
        .set({ username: 'sim-merchant', password: 'sim-merchant-password' })
        .send({ app_key: 'sim-app-key', app_secret: 'sim-app-secret-key' });
      expect(granted.body.statusCode).toBe('0000');
      token = String(granted.body.id_token);
      await host.waitFor(async () => {
        const checked = await query(paymentId);
        return checked['externalCode'] === '2002';
      }, 'payment to expire');
    } finally {
      await host.resetClock();
    }
  });
});
