import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createBkashRouter } from '../src/routes.js';
import { makeCtx, type FakeContext } from './fakes.js';

const GRANT_HEADERS = {
  username: 'sim-merchant',
  password: 'sim-merchant-password',
};

const CREATE = {
  payerReference: 'TEST001ABC',
  callbackURL: 'https://merchant.test/cb',
  amount: '150.75',
  currency: 'BDT',
  intent: 'sale',
  merchantInvoiceNumber: 'INV-1',
};

describe('bkash routes', () => {
  let fakes: FakeContext;
  let app: express.Application;

  beforeEach(() => {
    fakes = makeCtx();
    fakes.stores.seedApp();
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use(createBkashRouter(fakes.ctx));
  });

  async function grant(): Promise<{ idToken: string; refreshToken: string }> {
    const res = await request(app)
      .post('/v2/tokenized-checkout/auth/grant-token')
      .set(GRANT_HEADERS)
      .send({ app_key: 'sim-app-key', app_secret: 'sim-app-secret-key' });
    expect(res.status).toBe(200);
    expect(res.body.statusCode).toBe('0000');
    return { idToken: String(res.body.id_token), refreshToken: String(res.body.refresh_token) };
  }

  function authHeaders(idToken: string): Record<string, string> {
    return { authorization: idToken, 'x-app-key': 'sim-app-key' };
  }

  async function createOk(
    overrides: Record<string, unknown> = {},
    idToken?: string,
  ): Promise<{ paymentId: string; body: Record<string, unknown> }> {
    const token = idToken ?? (await grant()).idToken;
    const res = await request(app)
      .post('/v2/tokenized-checkout/payment/create')
      .set(authHeaders(token))
      .send({ ...CREATE, ...overrides });
    expect(res.status).toBe(200);
    expect(res.body.transactionStatus).toBe('Initiated');
    return { paymentId: String(res.body.paymentId), body: res.body as Record<string, unknown> };
  }

  it('grants and rotates tokens, rejecting bad credentials', async () => {
    const first = await grant();
    expect(first.idToken).toMatch(/^sim_id_/);

    const bad = await request(app)
      .post('/v2/tokenized-checkout/auth/grant-token')
      .set({ ...GRANT_HEADERS, password: 'nope' })
      .send({ app_key: 'sim-app-key', app_secret: 'sim-app-secret-key' });
    expect(bad.body).toMatchObject({ statusCode: '9999' });

    const refreshed = await request(app)
      .post('/v2/tokenized-checkout/auth/refresh-token')
      .set(GRANT_HEADERS)
      .send({
        app_key: 'sim-app-key',
        app_secret: 'sim-app-secret-key',
        refresh_token: first.refreshToken,
      });
    expect(refreshed.body.statusCode).toBe('0000');
    expect(String(refreshed.body.id_token)).not.toBe(first.idToken);

    // Rotation invalidates the previous refresh token.
    const reuse = await request(app)
      .post('/v2/tokenized-checkout/auth/refresh-token')
      .set(GRANT_HEADERS)
      .send({
        app_key: 'sim-app-key',
        app_secret: 'sim-app-secret-key',
        refresh_token: first.refreshToken,
      });
    expect(reuse.body).toMatchObject({ statusCode: '9999' });
  });

  it('rejects unauthenticated payment calls with gateway errors', async () => {
    const noToken = await request(app)
      .post('/v2/tokenized-checkout/payment/create')
      .set({ 'x-app-key': 'sim-app-key' })
      .send(CREATE);
    expect(noToken.body.externalCode).toBe('2003');

    const { idToken } = await grant();
    const wrongKey = await request(app)
      .post('/v2/tokenized-checkout/payment/create')
      .set({ authorization: idToken, 'x-app-key': 'nope' })
      .send(CREATE);
    expect(wrongKey.body.externalCode).toBe('2001');

    // Bearer prefix is accepted as a leniency.
    const bearer = await request(app)
      .post('/v2/tokenized-checkout/payment/create')
      .set({ authorization: `Bearer ${idToken}`, 'x-app-key': 'sim-app-key' })
      .send(CREATE);
    expect(bearer.body.transactionStatus).toBe('Initiated');
  });

  it('creates payments with echoes, callback URLs and a signature', async () => {
    const { paymentId, body } = await createOk();
    expect(paymentId).toMatch(/^TR0011[0-9A-Za-z]{7}\d{13}$/);
    expect(body).toMatchObject({
      amount: '150.75',
      currency: 'BDT',
      intent: 'sale',
      merchantInvoiceNumber: 'INV-1',
      callbackURL: 'https://merchant.test/cb',
    });
    expect(String(body['bkashURL'])).toContain(`/bkash/checkout?paymentId=${paymentId}`);
    expect(String(body['successCallbackURL'])).toContain('status=success');
    expect(String(body['failureCallbackURL'])).toContain('status=failure');
    expect(String(body['cancelledCallbackURL'])).toContain('status=cancel');
    expect(String(body['signature'])).toMatch(/^[0-9A-Za-z]{10}$/);
    expect(String(body['paymentCreateTime'])).toMatch(/^\d{4}-\d{2}-\d{2}T.* GMT\+0600$/);

    const txn = await fakes.stores.findTransactionBySession('bkash', paymentId);
    expect(txn?.state).toBe('initiated');
    expect(txn?.amountMinor).toBe(15075);
    const types = fakes.stores.events.map((event) => event.type);
    expect(types).toContain('transaction.created');
    expect(types).toContain('bkash.create.received');
  });

  it('validates create fields with documented codes', async () => {
    const { idToken } = await grant();
    const attempt = async (overrides: Record<string, unknown>): Promise<string> => {
      const res = await request(app)
        .post('/v2/tokenized-checkout/payment/create')
        .set(authHeaders(idToken))
        .send({ ...CREATE, ...overrides });
      expect(res.status).toBe(200);
      return String(res.body.externalCode);
    };
    expect(await attempt({ amount: 'two' })).toBe('2006');
    expect(await attempt({ amount: '0' })).toBe('2006');
    expect(await attempt({ amount: '1.999' })).toBe('2006');
    expect(await attempt({ currency: 'USD' })).toBe('2007');
    expect(await attempt({ intent: 'capture' })).toBe('2008');
    expect(await attempt({ callbackURL: '/relative' })).toBe('2049');
    expect(await attempt({ payerReference: 'a<b' })).toBe('2048');
    expect(await attempt({ merchantInvoiceNumber: 'x'.repeat(300) })).toBe('2031');
    const missing = await request(app)
      .post('/v2/tokenized-checkout/payment/create')
      .set(authHeaders(idToken))
      .send({ ...CREATE, amount: undefined });
    expect(missing.body.externalCode).toBe('2065');
  });

  it('serves the mock checkout page with the sandbox label', async () => {
    const { paymentId } = await createOk();
    const page = await request(app).get(`/bkash/checkout?paymentId=${paymentId}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('PaySim sandbox — test only, no real money');
    expect(page.text).toContain('INV-1');
    expect(page.text).toContain('name="wallet"');
    expect(page.text).toContain('value="fail"');
    expect(page.text).toContain('value="cancel"');

    // Wallet number -> OTP -> PIN; bad numbers stay on step 1.
    const bad = await request(app)
      .post('/bkash/checkout')
      .type('form')
      .send({ paymentId, step: 'otp', wallet: '123' });
    expect(bad.text).toContain('role="alert"');
    expect(bad.text).toContain('name="wallet"');
    const otp = await request(app)
      .post('/bkash/checkout')
      .type('form')
      .send({ paymentId, step: 'otp', wallet: '01770618575' });
    expect(otp.text).toContain('Verification code');
    expect(otp.text).toContain('017****8575');
    const pin = await request(app)
      .post('/bkash/checkout')
      .type('form')
      .send({ paymentId, step: 'pin', wallet: '01770618575', pin: '12121' });
    expect(pin.text).toContain('value="success"');
    expect(pin.text).not.toContain('12121"');
    const txnAfter = fakes.stores.txns.find((t) => t.gatewaySessionKey === paymentId);
    expect(txnAfter?.state).toBe('initiated');
    expect(JSON.stringify(txnAfter?.metadata)).not.toContain('12121');

    expect((await request(app).get('/bkash/checkout')).status).toBe(400);
    expect((await request(app).get('/bkash/checkout?paymentId=nope')).status).toBe(404);
  });

  it('success button verifies and renders the GET redirect (no server POST)', async () => {
    const { paymentId } = await createOk();
    const res = await request(app)
      .post('/bkash/checkout')
      .type('form')
      .send({ paymentId, action: 'success' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('https://merchant.test/cb?');
    expect(res.text).toContain('status=success');
    expect(res.text).toContain(`paymentID=${paymentId}`);
    expect(res.text).toContain('id="continue"');

    expect(fakes.delivered).toHaveLength(0);
    const txn = await fakes.stores.findTransactionBySession('bkash', paymentId);
    expect(txn?.state).toBe('verified');
    expect(fakes.stores.events.map((event) => event.type)).toContain('bkash.callback.ready');

    // Repeat clicks are idempotent.
    const again = await request(app)
      .post('/bkash/checkout')
      .type('form')
      .send({ paymentId, action: 'success' });
    expect(again.text).toContain('already verified');
  });

  it('fail and cancel buttons drive failure and cancel redirects', async () => {
    const fail = await createOk({ merchantInvoiceNumber: 'INV-F' });
    const failRes = await request(app)
      .post('/bkash/checkout')
      .type('form')
      .send({ paymentId: fail.paymentId, action: 'fail' });
    expect(failRes.text).toContain('status=failure');
    expect((await fakes.stores.findTransactionBySession('bkash', fail.paymentId))?.state).toBe(
      'failed',
    );

    const cancel = await createOk({ merchantInvoiceNumber: 'INV-C' });
    const cancelRes = await request(app)
      .post('/bkash/checkout')
      .type('form')
      .send({ paymentId: cancel.paymentId, action: 'cancel' });
    expect(cancelRes.text).toContain('status=cancel');
  });

  it('executes verified payments once, then answers 2062', async () => {
    const { idToken } = await grant();
    const { paymentId } = await createOk({ merchantInvoiceNumber: 'INV-E' }, idToken);
    const execute = (id: string): Promise<{ status: number; body: Record<string, unknown> }> =>
      request(app)
        .post('/v2/tokenized-checkout/payment/execute')
        .set(authHeaders(idToken))
        .send({ paymentId: id })
        .then((res) => ({ status: res.status, body: res.body as Record<string, unknown> }));

    const early = await execute(paymentId);
    expect(early.body.externalCode).toBe('2060');

    await request(app).post('/bkash/checkout').type('form').send({ paymentId, action: 'success' });
    const done = await execute(paymentId);
    expect(done.body).toMatchObject({ transactionStatus: 'Completed', amount: '150.75' });
    expect(String(done.body['trxId'])).toMatch(/^[A-Z0-9]{9}$/);
    expect(done.body['payerType']).toBe('Customer');

    const again = await execute(paymentId);
    expect(again.body).toMatchObject({
      externalCode: '2062',
      internalCode: 'payment_already_completed',
    });

    const unknown = await execute('TR0011XXXXXXX0000000000000');
    expect(unknown.body).toMatchObject({
      externalCode: '2002',
      internalCode: 'invalid_payment_id',
    });
  });

  it('queries Initiated/Complete before execute and Completed after', async () => {
    const { idToken } = await grant();
    const { paymentId } = await createOk({ merchantInvoiceNumber: 'INV-Q' }, idToken);
    const query = async (): Promise<Record<string, unknown>> => {
      const res = await request(app)
        .post('/v2/tokenized-checkout/query/payment')
        .set(authHeaders(idToken))
        .send({ paymentId });
      expect(res.status).toBe(200);
      return res.body as Record<string, unknown>;
    };

    const fresh = await query();
    expect(fresh).toMatchObject({
      transactionStatus: 'Initiated',
      verificationStatus: 'Incomplete',
    });
    expect(fresh['trxId']).toBeUndefined();
    expect(fresh['merchantInvoice']).toBe('INV-Q');

    await request(app).post('/bkash/checkout').type('form').send({ paymentId, action: 'success' });
    const verified = await query();
    expect(verified).toMatchObject({
      transactionStatus: 'Initiated',
      verificationStatus: 'Complete',
    });

    await request(app)
      .post('/v2/tokenized-checkout/payment/execute')
      .set(authHeaders(idToken))
      .send({ paymentId });
    const completed = await query();
    expect(completed).toMatchObject({
      transactionStatus: 'Completed',
      verificationStatus: 'Complete',
    });
    expect(String(completed['trxId'])).toMatch(/^[A-Z0-9]{9}$/);

    const unknown = await request(app)
      .post('/v2/tokenized-checkout/query/payment')
      .set(authHeaders(idToken))
      .send({ paymentId: 'TR0011XXXXXXX0000000000000' });
    expect(unknown.body.externalCode).toBe('2002');
  });
});
