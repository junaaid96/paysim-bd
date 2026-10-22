// Real-sandbox mode with MOCKED provider responses (no network).
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setSslczFetch } from '../src/real.js';
import { createSslcommerzRouter } from '../src/routes.js';
import { makeCtx, type FakeContext } from './fakes.js';

const INIT = {
  store_id: 'testbox',
  store_passwd: 'qwerty',
  total_amount: '250',
  currency: 'BDT',
  tran_id: 'ORDER-REAL-1',
  product_category: 'food',
  success_url: 'http://client.test/pay/success',
  fail_url: 'http://client.test/pay/fail',
  cancel_url: 'http://client.test/pay/cancel',
  ipn_url: 'http://client.test/pay/ipn',
};

interface Call {
  url: string;
  body: string;
}

describe('sslcommerz real-sandbox mode (mocked provider)', () => {
  let fakes: FakeContext;
  let app: express.Application;
  let calls: Call[];
  let validation: Record<string, unknown>;

  beforeEach(() => {
    calls = [];
    fakes = makeCtx();
    fakes.stores.seedApp({
      sandbox: { mode: 'real', keys: { store_id: 'mystore', store_passwd: 'mysecret' } },
    });
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use(createSslcommerzRouter(fakes.ctx));
    setSslczFetch((async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: String(init?.body ?? '') });
      let body: unknown = {};
      if (url.includes('/gwprocess/v4/api.php')) {
        body = {
          status: 'SUCCESS',
          sessionkey: 'REALSESSION',
          GatewayPageURL: 'https://sandbox.sslcommerz.com/EasyCheckOut/testREAL',
        };
      } else if (url.includes('validationserverAPI.php')) {
        body = validation;
      } else if (url.includes('merchantTransIDvalidationAPI.php')) {
        body = { APIConnect: 'DONE', status: 'success', refund_ref_id: 'REALREF1' };
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch);
  });

  afterEach(() => setSslczFetch(null));

  it('proxies init with the sandbox keys and returns the provider page', async () => {
    const res = await request(app).post('/gwprocess/v4/api.php').type('form').send(INIT);
    expect(res.body.status).toBe('SUCCESS');
    expect(res.body.GatewayPageURL).toBe('https://sandbox.sslcommerz.com/EasyCheckOut/testREAL');
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get('store_id')).toBe('mystore');
    expect(form.get('success_url')).toMatch(/\/gwprocess\/sandbox\/return\/.+\/success$/);
    expect(form.get('total_amount')).toBe('250.00');
    const txn = fakes.stores.txns[0]!;
    expect(txn.metadata['sandboxMode']).toBe('real');
  });

  it('validates success with the provider, forwards to the merchant and refunds at the provider', async () => {
    await request(app).post('/gwprocess/v4/api.php').type('form').send(INIT);
    const txn = fakes.stores.txns[0]!;
    validation = {
      status: 'VALID',
      tran_id: String(txn.metadata['providerTranId']),
      amount: '250.00',
      bank_tran_id: 'REALBANK1',
      tran_date: '2026-10-22 12:00:00',
      card_type: 'BKASH-BKash',
    };
    const back = await request(app)
      .post(`/gwprocess/sandbox/return/${txn.id}/success`)
      .type('form')
      .send({ val_id: 'REALVAL1', status: 'VALID' });
    expect(back.status).toBe(200);
    expect(back.text).toContain('http://client.test/pay/success');
    expect(back.text).toContain('REALVAL1');
    const paid = fakes.stores.txns[0]!;
    expect(paid.state).toBe('valid');
    expect(paid.metadata['bankTranId']).toBe('REALBANK1');

    // Merchant validates at PaySim with its PaySim credentials.
    const check = await request(app)
      .get('/validator/api/validationserverAPI.php')
      .query({ val_id: 'REALVAL1', store_id: 'testbox', store_passwd: 'qwerty', format: 'json' });
    expect(check.body.status).toBe('VALID');

    const refund = await request(app).get('/validator/api/merchantTransIDvalidationAPI.php').query({
      store_id: 'testbox',
      store_passwd: 'qwerty',
      bank_tran_id: 'REALBANK1',
      refund_amount: '100.00',
      refund_remarks: 'partial',
    });
    expect(refund.body.status).toBe('success');
    const refundCall = calls.find((c) => c.url.includes('merchantTransIDvalidationAPI'));
    expect(refundCall?.url).toContain('store_id=mystore');
    expect(refundCall?.url).toContain('refund_amount=100.00');
  });

  it('never trusts an unverifiable success', async () => {
    await request(app).post('/gwprocess/v4/api.php').type('form').send(INIT);
    const txn = fakes.stores.txns[0]!;
    validation = { status: 'INVALID_TRANSACTION' };
    const back = await request(app)
      .post(`/gwprocess/sandbox/return/${txn.id}/success`)
      .type('form')
      .send({ val_id: 'FORGED', status: 'VALID' });
    expect(back.text).toContain('http://client.test/pay/fail');
    expect(fakes.stores.txns[0]!.state).toBe('failed');
  });

  it('records cancel from the provider', async () => {
    await request(app).post('/gwprocess/v4/api.php').type('form').send(INIT);
    const txn = fakes.stores.txns[0]!;
    const back = await request(app)
      .post(`/gwprocess/sandbox/return/${txn.id}/cancel`)
      .type('form')
      .send({ status: 'CANCELLED' });
    expect(back.text).toContain('http://client.test/pay/cancel');
    expect(fakes.stores.txns[0]!.state).toBe('cancelled');
  });
});
