import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createBkashRouter } from '../src/routes.js';
import { makeCtx, type FakeContext } from './fakes.js';

const CREATE = {
  payerReference: 'TEST001ABC',
  callbackURL: 'https://merchant.test/cb',
  amount: '500.00',
  currency: 'BDT',
  intent: 'sale',
  merchantInvoiceNumber: 'INV-R',
};
const REFUND = '/v2/tokenized-checkout/refund/payment/transaction';
const STATUS = '/v2/tokenized-checkout/refund/payment/status';

describe('bkash refund API', () => {
  let fakes: FakeContext;
  let app: express.Application;
  let headers: Record<string, string>;

  beforeEach(async () => {
    fakes = makeCtx();
    fakes.stores.seedApp();
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use(createBkashRouter(fakes.ctx));
    const grant = await request(app)
      .post('/v2/tokenized-checkout/auth/grant-token')
      .set({ username: 'sim-merchant', password: 'sim-merchant-password' })
      .send({ app_key: 'sim-app-key', app_secret: 'sim-app-secret-key' });
    headers = { authorization: String(grant.body.id_token), 'x-app-key': 'sim-app-key' };
  });

  async function completed(execute = true): Promise<{ paymentId: string; trxId: string }> {
    const created = await request(app)
      .post('/v2/tokenized-checkout/payment/create')
      .set(headers)
      .send(CREATE);
    const paymentId = String(created.body.paymentId);
    await request(app).post('/bkash/checkout').type('form').send({ paymentId, action: 'success' });
    if (!execute) return { paymentId, trxId: 'none' };
    const exec = await request(app)
      .post('/v2/tokenized-checkout/payment/execute')
      .set(headers)
      .send({ paymentId });
    return { paymentId, trxId: String(exec.body.trxId) };
  }

  it('refunds partially and fully, then rejects over-refunds', async () => {
    const pay = await completed();
    const a = await request(app)
      .post(REFUND)
      .set(headers)
      .send({ ...pay, refundAmount: '120.50', reason: 'item' });
    expect(a.body).toMatchObject({
      refundTransactionStatus: 'Completed',
      refundAmount: '120.50',
      originalTrxAmount: '500.00',
    });
    const over = await request(app)
      .post(REFUND)
      .set(headers)
      .send({ ...pay, refundAmount: '400', reason: 'x' });
    expect(over.body.externalCode).toBe('2072');
    const rest = await request(app)
      .post(REFUND)
      .set(headers)
      .send({ ...pay, refundAmount: '379.50', reason: 'rest' });
    expect(rest.body.refundTransactionStatus).toBe('Completed');
    const status = await request(app).post(STATUS).set(headers).send(pay);
    expect(status.body.refundTransactions).toHaveLength(2);
    expect(fakes.stores.txns[0]?.metadata['refundStatus']).toBe('full');
  });

  it('honours Idempotency-Key and simulated declines', async () => {
    const pay = await completed();
    const once = await request(app)
      .post(REFUND)
      .set({ ...headers, 'idempotency-key': 'k1' })
      .send({ ...pay, refundAmount: '50', reason: 'x' });
    const twice = await request(app)
      .post(REFUND)
      .set({ ...headers, 'idempotency-key': 'k1' })
      .send({ ...pay, refundAmount: '50', reason: 'x' });
    expect(twice.body.refundTrxId).toBe(once.body.refundTrxId);
    expect(fakes.stores.txns[0]?.metadata['refundedMinor']).toBe(5000);
    const declined = await request(app)
      .post(REFUND)
      .set(headers)
      .send({ ...pay, refundAmount: '50', reason: 'SIM:refund_fail' });
    expect(declined.body.externalCode).toBe('2003');
    expect(fakes.stores.txns[0]?.metadata['refundedMinor']).toBe(5000);
  });

  it('only refunds executed payments with the matching trxId', async () => {
    const pay = await completed(false);
    const res = await request(app)
      .post(REFUND)
      .set(headers)
      .send({ ...pay, refundAmount: '10', reason: 'x' });
    expect(res.body.externalCode).toBe('2056');
    const bad = await request(app)
      .post(REFUND)
      .set(headers)
      .send({ paymentId: 'nope', trxId: 'x', refundAmount: '10' });
    expect(bad.body.externalCode).toBe('2002');
    const zero = await request(app)
      .post(REFUND)
      .set(headers)
      .send({ ...pay, refundAmount: '0' });
    expect(zero.body.externalCode).toBe('2071');
  });
});
