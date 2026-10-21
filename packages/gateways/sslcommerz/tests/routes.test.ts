import { createHash } from 'node:crypto';

import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { AUTO_SUBMIT_SCRIPT } from '../src/pages.js';
import { createSslcommerzRouter } from '../src/routes.js';
import { verifySignature } from '../src/verify.js';
import { makeCtx, type FakeContext } from './fakes.js';

const INIT = {
  store_id: 'testbox',
  store_passwd: 'qwerty',
  total_amount: '103',
  currency: 'BDT',
  tran_id: 'ORDER-1',
  product_category: 'test',
  success_url: 'http://client.test/pay/success',
  fail_url: 'http://client.test/pay/fail',
  cancel_url: 'http://client.test/pay/cancel',
  ipn_url: 'http://client.test/pay/ipn',
  value_a: 'ref001',
};

describe('sslcommerz routes', () => {
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

  async function initOk(overrides: Record<string, unknown> = {}): Promise<{ sessionkey: string }> {
    const res = await request(app)
      .post('/gwprocess/v4/api.php')
      .send({ ...INIT, ...overrides });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SUCCESS');
    return { sessionkey: String(res.body.sessionkey) };
  }

  it('inits a session over JSON and urlencoded bodies', async () => {
    const json = await request(app).post('/gwprocess/v4/api.php').send(INIT);
    expect(json.body.sessionkey).toMatch(/^[0-9A-F]{32}$/);
    expect(json.body.GatewayPageURL).toContain('/gwprocess/v4/gw.php?Q=PAY&SESSIONKEY=');

    const form = await request(app)
      .post('/gwprocess/v4/api.php')
      .type('form')
      .send({ ...INIT, tran_id: 'ORDER-2' });
    expect(form.body.status).toBe('SUCCESS');

    const txn = await fakes.stores.findTransactionByGatewayTxnId('sslcommerz', 'ORDER-1');
    expect(txn?.state).toBe('initiated');
    expect(txn?.amountMinor).toBe(10300);
    const types = fakes.stores.events.map((event) => event.type);
    expect(types).toContain('transaction.created');
    expect(types).toContain('sslcommerz.init.received');
  });

  it('rejects bad credentials, duplicates, amounts and urls as FAILED', async () => {
    const badPass = await request(app)
      .post('/gwprocess/v4/api.php')
      .send({ ...INIT, store_passwd: 'nope' });
    expect(badPass.body).toMatchObject({ status: 'FAILED' });

    const missing = await request(app)
      .post('/gwprocess/v4/api.php')
      .send({ ...INIT, tran_id: undefined });
    expect(missing.body.status).toBe('FAILED');

    await initOk();
    const duplicate = await request(app).post('/gwprocess/v4/api.php').send(INIT);
    expect(duplicate.body).toMatchObject({ status: 'FAILED', failedreason: 'Duplicate tran_id' });

    const tiny = await request(app)
      .post('/gwprocess/v4/api.php')
      .send({ ...INIT, tran_id: 'ORDER-3', total_amount: '5' });
    expect(tiny.body.status).toBe('FAILED');

    const relative = await request(app)
      .post('/gwprocess/v4/api.php')
      .send({ ...INIT, tran_id: 'ORDER-4', success_url: '/relative' });
    expect(relative.body.status).toBe('FAILED');
  });

  it('serves the mock checkout page with a SIMULATOR banner', async () => {
    const { sessionkey } = await initOk();
    const page = await request(app).get(`/gwprocess/v4/gw.php?SESSIONKEY=${sessionkey}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('SIMULATOR');
    expect(page.text).toContain('ORDER-1');
    expect(page.text).toContain('value="success"');
    expect(page.text).toContain('value="fail"');
    expect(page.text).toContain('value="cancel"');

    expect((await request(app).get('/gwprocess/v4/gw.php')).status).toBe(400);
    expect((await request(app).get('/gwprocess/v4/gw.php?SESSIONKEY=nope')).status).toBe(404);
  });

  it('success button sends a signed VALID IPN then renders the return form', async () => {
    const { sessionkey } = await initOk();
    const res = await request(app)
      .post(`/gwprocess/v4/gw.php?SESSIONKEY=${sessionkey}`)
      .type('form')
      .send({ action: 'success' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('http://client.test/pay/success');
    expect(res.text).toContain('name="tran_id"');
    // The return page must be allowed to auto-POST to the merchant's URL.
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain('form-action http: https:');
    const hash = createHash('sha256').update(AUTO_SUBMIT_SCRIPT).digest('base64');
    expect(csp).toContain(`'sha256-${hash}'`);
    expect(res.text).toContain(`<script>${AUTO_SUBMIT_SCRIPT}</script>`);

    expect(fakes.delivered).toHaveLength(1);
    const ipn = fakes.delivered[0];
    expect(ipn?.targetUrl).toBe('http://client.test/pay/ipn');
    expect(ipn?.payload['status']).toBe('VALID');
    expect(
      verifySignature(
        ipn?.payload ?? {},
        ipn?.payload['verify_key'] ?? '',
        'qwerty',
        ipn?.payload['verify_sign'] ?? '',
      ),
    ).toBe(true);

    const txn = await fakes.stores.findTransactionByGatewayTxnId('sslcommerz', 'ORDER-1');
    expect(txn?.state).toBe('valid');

    // Repeat clicks are idempotent: no second IPN.
    const again = await request(app)
      .post(`/gwprocess/v4/gw.php?SESSIONKEY=${sessionkey}`)
      .type('form')
      .send({ action: 'success' });
    expect(again.text).toContain('already valid');
    expect(fakes.delivered).toHaveLength(1);
  });

  it('fail and cancel buttons drive FAILED and CANCELLED outcomes', async () => {
    const failInit = await initOk({ tran_id: 'ORDER-F' });
    await request(app)
      .post(`/gwprocess/v4/gw.php?SESSIONKEY=${failInit.sessionkey}`)
      .type('form')
      .send({ action: 'fail' });
    expect(fakes.delivered[0]?.payload['status']).toBe('FAILED');
    expect(fakes.delivered[0]?.payload['val_id']).toBe('');
    expect((await fakes.stores.findTransactionByGatewayTxnId('sslcommerz', 'ORDER-F'))?.state).toBe(
      'failed',
    );

    const cancelInit = await initOk({ tran_id: 'ORDER-C' });
    const res = await request(app)
      .post(`/gwprocess/v4/gw.php?SESSIONKEY=${cancelInit.sessionkey}`)
      .type('form')
      .send({ action: 'cancel' });
    expect(res.text).toContain('http://client.test/pay/cancel');
    expect(fakes.delivered[1]?.payload['status']).toBe('CANCELLED');
  });

  it('skips IPN with an event when no ipn_url was given', async () => {
    const { sessionkey } = await initOk({ tran_id: 'ORDER-N', ipn_url: undefined });
    await request(app)
      .post(`/gwprocess/v4/gw.php?SESSIONKEY=${sessionkey}`)
      .type('form')
      .send({ action: 'success' });
    expect(fakes.delivered).toHaveLength(0);
    expect(fakes.stores.events.map((event) => event.type)).toContain('sslcommerz.ipn.skipped');
  });

  it('validates by val_id: VALID once, then VALIDATED', async () => {
    const { sessionkey } = await initOk();
    await request(app)
      .post(`/gwprocess/v4/gw.php?SESSIONKEY=${sessionkey}`)
      .type('form')
      .send({ action: 'success' });
    const txn = await fakes.stores.findTransactionByGatewayTxnId('sslcommerz', 'ORDER-1');
    const valId = txn?.metadata['valId'] as string;

    const first = await request(app).get(
      `/validator/api/validationserverAPI.php?val_id=${valId}&store_id=testbox&store_passwd=qwerty&format=json`,
    );
    expect(first.body.status).toBe('VALID');
    expect(first.body.tran_id).toBe('ORDER-1');
    expect(first.body.APIConnect).toBe('DONE');

    const second = await request(app).get(
      `/validator/api/validationserverAPI.php?val_id=${valId}&store_id=testbox&store_passwd=qwerty&format=json`,
    );
    expect(second.body.status).toBe('VALIDATED');

    // Another store's credentials cannot validate this payment.
    fakes.stores.seedApp({
      id: 'other-app',
      credentials: { store_id: 'otherbox', store_passwd: 'other' },
    });
    const foreign = await request(app).get(
      `/validator/api/validationserverAPI.php?val_id=${valId}&store_id=otherbox&store_passwd=other&format=json`,
    );
    expect(foreign.body.status).toBe('INVALID_TRANSACTION');

    const unknown = await request(app).get(
      '/validator/api/validationserverAPI.php?val_id=nope&store_id=testbox&store_passwd=qwerty&format=json',
    );
    expect(unknown.body).toEqual({ status: 'INVALID_TRANSACTION' });

    const badCreds = await request(app).get(
      `/validator/api/validationserverAPI.php?val_id=${valId}&store_id=testbox&store_passwd=nope&format=json`,
    );
    expect(badCreds.body).toEqual({ status: 'INVALID_TRANSACTION' });
  });
});
