import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { upayPlugin } from '../src/index.js';
import { setUpayFetch } from '../src/real.js';
import { createUpayRouter } from '../src/routes.js';
import { makeCtx, type FakeContext } from './fakes.js';

const REAL_KEYS = {
  merchant_id: 'UCB-TEST',
  merchant_key: 'test-key',
  merchant_code: 'MC1',
  merchant_name: 'Shop',
  merchant_mobile: '01700000000',
  merchant_category_code: '5999',
};

describe('upay simulator', () => {
  let fakes: FakeContext;
  let app: express.Application;
  let n = 0;

  beforeEach(() => {
    fakes = makeCtx();
    fakes.stores.seedApp();
    app = express();
    app.use(express.json());
    app.use(createUpayRouter(fakes.ctx));
  });

  async function auth(): Promise<string> {
    const res = await request(app)
      .post('/payment/merchant-auth/')
      .send({ merchant_id: 'SIM-UPAY-001', merchant_key: 'sim-upay-merchant-key' });
    expect(res.body.code).toBe('MAS2001');
    return String(res.body.data.token);
  }

  async function init(token: string, amount = '100.00') {
    n += 1;
    return request(app)
      .post('/payment/merchant-payment-init/')
      .set('authorization', `UPAY ${token}`)
      .send({
        date: '2026-10-25',
        txn_id: `T${n}`,
        invoice_id: `INV${n}`,
        amount,
        redirect_url: 'https://merchant.test/back',
        merchant_id: 'SIM-UPAY-001',
      });
  }

  it('rejects bad credentials and missing token', async () => {
    const bad = await request(app)
      .post('/payment/merchant-auth/')
      .send({ merchant_id: 'SIM-UPAY-001', merchant_key: 'nope' });
    expect(bad.status).toBe(401);
    const res = await request(app).post('/payment/merchant-payment-init/').send({});
    expect(res.body.code).toBe('UNA4001');
  });

  it('pays, reports status, partial then full refund', async () => {
    const token = await auth();
    const res = await init(token);
    expect(res.body.code).toBe('MPIS2002');
    const session = String(res.body.data.session_id);
    expect(res.body.data.gateway_url).toContain(`/upay/checkout?session_id=${session}`);
    const page = await request(app).get(`/upay/checkout?session_id=${session}`);
    expect(page.text).toContain('PaySim sandbox');
    const done = await request(app)
      .post('/upay/checkout')
      .type('form')
      .send({ session_id: session, action: 'success', wallet: '01800000000' });
    expect(done.text).toContain('status=success');
    const status = await request(app)
      .get(`/payment/single-payment-status/${res.body.data.txn_id}/`)
      .set('authorization', `UPAY ${token}`);
    expect(status.body.code).toBe('PS2005');
    expect(status.body.data.status).toBe('success');
    const part = await request(app)
      .post('/payment/bulk/refund/')
      .set('authorization', `UPAY ${token}`)
      .send([{ txn_id: res.body.data.txn_id, refund_amount: '40.00' }]);
    expect(part.body.data.success_list).toEqual([res.body.data.txn_id]);
    const rest = await request(app)
      .post('/payment/bulk/refund/')
      .set('authorization', `UPAY ${token}`)
      .send([{ txn_id: res.body.data.txn_id, refund_amount: '60.00' }]);
    expect(rest.body.data.success_list).toEqual([res.body.data.txn_id]);
    const over = await request(app)
      .post('/payment/bulk/refund/')
      .set('authorization', `UPAY ${token}`)
      .send([{ txn_id: res.body.data.txn_id, refund_amount: '1.00' }]);
    expect(Object.keys(over.body.data.failed_list)).toEqual([res.body.data.txn_id]);
  });

  it('fails a payment and refuses refund; rejects duplicates', async () => {
    const token = await auth();
    const res = await init(token);
    const session = String(res.body.data.session_id);
    const done = await request(app)
      .post('/upay/checkout')
      .type('form')
      .send({ session_id: session, action: 'fail' });
    expect(done.text).toContain('status=failed');
    const ref = await request(app)
      .post('/payment/bulk/refund/')
      .set('authorization', `UPAY ${token}`)
      .send([{ txn_id: res.body.data.txn_id, refund_amount: '1.00' }]);
    expect(ref.body.data.success_list).toEqual([]);
    n -= 1;
    const dup = await init(token);
    expect(dup.body.code).toBe('DTP4003');
  });
});

describe('upay real sandbox (mocked provider)', () => {
  afterEach(() => setUpayFetch(null));

  it('validates keys and needs required merchant fields', () => {
    expect(upayPlugin.sandbox?.validateKeys({ merchant_id: 'x' }).ok).toBe(false);
    expect(upayPlugin.sandbox?.validateKeys(REAL_KEYS).ok).toBe(true);
  });

  it('inits against Upay, confirms on return and refunds', async () => {
    const calls: string[] = [];
    setUpayFetch((async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method} ${u}`);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (u.endsWith('/payment/merchant-auth/'))
        return json({ code: 'MAS2001', data: { token: 'tok' } });
      if (u.endsWith('/payment/merchant-payment-init/'))
        return json({
          code: 'MPIS2002',
          data: {
            gateway_url: 'https://uat-pg.upay.systems/pay/abc',
            session_id: 's',
            trx_id: 'X',
          },
        });
      if (u.includes('/single-payment-status/')) {
        const id = decodeURIComponent(u.split('/single-payment-status/')[1]!.replace(/\/$/, ''));
        return json({
          code: 'PS2005',
          data: { txn_id: id, status: 'success', amount: 100, trx_id: 'X' },
        });
      }
      if (u.endsWith('/payment/bulk/refund/')) {
        const body = JSON.parse(String(init?.body)) as Array<{ txn_id: string }>;
        return json({
          code: 'MPR_200',
          data: {
            success_list: [],
            failed_list: { [body[0]!.txn_id]: { en: 'Your request is under process', bn: '' } },
          },
        });
      }
      return json({}, 404);
    }) as typeof fetch);
    const fakes = makeCtx();
    const seeded = fakes.stores.seedApp({ sandbox: { mode: 'real', keys: REAL_KEYS } } as never);
    const app = express();
    app.use(express.json());
    app.use(createUpayRouter(fakes.ctx));
    const token = (
      await request(app)
        .post('/payment/merchant-auth/')
        .send({ merchant_id: 'SIM-UPAY-001', merchant_key: 'sim-upay-merchant-key' })
    ).body.data.token;
    const res = await request(app)
      .post('/payment/merchant-payment-init/')
      .set('authorization', `UPAY ${token}`)
      .send({
        date: '2026-10-25',
        txn_id: 'R1',
        invoice_id: 'INV-R1',
        amount: '100.00',
        redirect_url: 'https://merchant.test/back',
        merchant_id: 'SIM-UPAY-001',
      });
    expect(res.body.data.gateway_url).toBe('https://uat-pg.upay.systems/pay/abc');
    const txn = fakes.stores.txns.find((t) => t.gatewayTxnId === 'R1')!;
    expect(txn.metadata['sandboxMode']).toBe('real');
    const back = await request(app).get(`/upay/sandbox/callback/${txn.id}?status=success`);
    expect(back.status).toBe(302);
    expect(back.headers['location']).toContain('status=success');
    const settled = await upayPlugin.sandbox!.settleRefund!(
      fakes.ctx,
      (await fakes.stores.getTransaction(txn.id))!,
      seeded,
      { amountMinor: 5000 } as never,
    );
    expect(settled.ok).toBe(true);
    expect(calls.some((c) => c.includes('uat-pg.upay.systems/payment/merchant-auth/'))).toBe(true);
  });

  it('testConnection reports a provider rejection', async () => {
    setUpayFetch(
      (async () =>
        new Response(JSON.stringify({ code: 'MAE', message: 'bad' }), {
          status: 401,
        })) as typeof fetch,
    );
    const r = await upayPlugin.sandbox!.testConnection!(
      makeCtx().ctx as never,
      null as never,
      REAL_KEYS,
    );
    expect(r.ok).toBe(false);
  });
});
