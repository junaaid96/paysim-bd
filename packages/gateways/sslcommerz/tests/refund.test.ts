import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createSslcommerzRouter } from '../src/routes.js';
import { makeCtx, type FakeContext } from './fakes.js';

const INIT = {
  store_id: 'testbox',
  store_passwd: 'qwerty',
  total_amount: '500',
  currency: 'BDT',
  tran_id: 'ORDER-R1',
  product_category: 'test',
  success_url: 'http://client.test/pay/success',
  fail_url: 'http://client.test/pay/fail',
  cancel_url: 'http://client.test/pay/cancel',
};
const PATH = '/validator/api/merchantTransIDvalidationAPI.php';
const CREDS = { store_id: 'testbox', store_passwd: 'qwerty', format: 'json' };

describe('sslcommerz refund API', () => {
  let fakes: FakeContext;
  let app: express.Application;

  beforeEach(() => {
    fakes = makeCtx();
    fakes.stores.seedApp();
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use(createSslcommerzRouter(fakes.ctx));
  });

  async function paid(action = 'success'): Promise<string> {
    const init = await request(app).post('/gwprocess/v4/api.php').send(INIT);
    await request(app)
      .post('/gwprocess/v4/gw.php')
      .type('form')
      .send({ SESSIONKEY: init.body.sessionkey, action });
    const txn = fakes.stores.txns.find((t) => t.gatewayTxnId === INIT.tran_id);
    return String(txn?.metadata['bankTranId'] ?? '');
  }

  it('refunds partially then fully, and blocks over-refunds', async () => {
    const bank = await paid();
    const first = await request(app)
      .get(PATH)
      .query({
        ...CREDS,
        bank_tran_id: bank,
        refund_amount: '200.00',
        refund_remarks: 'partial',
        refund_trans_id: 'R-1',
      });
    expect(first.body).toMatchObject({
      APIConnect: 'DONE',
      status: 'success',
      trans_id: 'ORDER-R1',
    });
    const over = await request(app)
      .get(PATH)
      .query({
        ...CREDS,
        bank_tran_id: bank,
        refund_amount: '300.01',
        refund_remarks: 'too much',
        refund_trans_id: 'R-2',
      });
    expect(over.body.status).toBe('failed');
    expect(over.body.errorReason).toMatch(/exceeds/);
    const rest = await request(app)
      .get(PATH)
      .query({
        ...CREDS,
        bank_tran_id: bank,
        refund_amount: '300',
        refund_remarks: 'rest',
        refund_trans_id: 'R-3',
      });
    expect(rest.body.status).toBe('success');
    const txn = fakes.stores.txns[0];
    expect(txn?.metadata['refundStatus']).toBe('full');
    expect(txn?.metadata['refundedMinor']).toBe(50000);
    expect(txn?.state).toBe('valid');
    const event = fakes.stores.events.find((e) => e.type === 'sslcommerz.refund.completed');
    expect(JSON.stringify(event?.data)).not.toContain('qwerty');
  });

  it('is idempotent on refund_trans_id and reports refund status', async () => {
    const bank = await paid();
    const query = {
      ...CREDS,
      bank_tran_id: bank,
      refund_amount: '100',
      refund_remarks: 'x',
      refund_trans_id: 'R-9',
    };
    const a = await request(app).get(PATH).query(query);
    const b = await request(app).get(PATH).query(query);
    expect(b.body.refund_ref_id).toBe(a.body.refund_ref_id);
    expect(fakes.stores.txns[0]?.metadata['refundedMinor']).toBe(10000);
    const conflict = await request(app)
      .get(PATH)
      .query({ ...query, refund_amount: '50' });
    expect(conflict.body.status).toBe('failed');
    const status = await request(app)
      .get(PATH)
      .query({ ...CREDS, refund_ref_id: a.body.refund_ref_id });
    expect(status.body).toMatchObject({
      APIConnect: 'DONE',
      status: 'refunded',
      tran_id: 'ORDER-R1',
    });
  });

  it('simulates a declined refund without moving money', async () => {
    const bank = await paid();
    const res = await request(app)
      .get(PATH)
      .query({
        ...CREDS,
        bank_tran_id: bank,
        refund_amount: '100',
        refund_remarks: 'SIM:refund_fail',
      });
    expect(res.body.status).toBe('failed');
    expect(fakes.stores.txns[0]?.metadata['refundedMinor']).toBe(0);
    const status = await request(app)
      .get(PATH)
      .query({ ...CREDS, refund_ref_id: res.body.refund_ref_id });
    expect(status.body.status).toBe('cancelled');
  });

  it('rejects refunds of unpaid payments and bad credentials', async () => {
    await paid('fail');
    const txn = fakes.stores.txns[0];
    expect(txn?.state).toBe('failed');
    const bad = await request(app)
      .get(PATH)
      .query({
        ...CREDS,
        store_passwd: 'nope',
        bank_tran_id: 'x',
        refund_amount: '1',
        refund_remarks: 'x',
      });
    expect(bad.body.APIConnect).toBe('INVALID_REQUEST');
    const unknown = await request(app)
      .get(PATH)
      .query({ ...CREDS, bank_tran_id: 'missing', refund_amount: '1', refund_remarks: 'x' });
    expect(unknown.body.status).toBe('failed');
  });
});
