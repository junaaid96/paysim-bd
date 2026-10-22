// Real-sandbox mode with MOCKED bKash responses (no network).
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setBkashFetch } from '../src/real.js';
import { createBkashRouter } from '../src/routes.js';
import { makeCtx, type FakeContext } from './fakes.js';

describe('bkash real-sandbox mode (mocked provider)', () => {
  let fakes: FakeContext;
  let app: express.Application;
  let headers: Record<string, string>;
  let calls: { path: string; body: Record<string, unknown>; auth: string }[];
  let grants: number;

  beforeEach(async () => {
    calls = [];
    grants = 0;
    fakes = makeCtx();
    fakes.stores.seedApp({
      sandbox: {
        mode: 'real',
        keys: { username: 'u', password: 'p', app_key: 'realkey', app_secret: 's' },
      },
    });
    app = express();
    app.use(express.json());
    app.use(createBkashRouter(fakes.ctx));
    setBkashFetch((async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const path = url.replace(/^.*\/tokenized\/checkout/, '');
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const hdrs = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ path, body, auth: hdrs['authorization'] ?? '' });
      let out: Record<string, unknown> = {};
      if (path === '/token/grant') {
        grants += 1;
        out = { statusCode: '0000', id_token: `real-token-${grants}` };
      } else if (path === '/create') {
        out = {
          statusCode: '0000',
          paymentID: 'TR0011REAL1',
          bkashURL: 'https://sandbox.payment.bkash.com/?paymentId=TR0011REAL1',
        };
      } else if (path === '/execute') {
        out = { statusCode: '0000', transactionStatus: 'Completed', trxID: 'REALTRX1' };
      } else if (path === '/payment/status') {
        out = { statusCode: '0000', transactionStatus: 'Completed', trxID: 'REALTRX1' };
      } else if (path === '/payment/refund') {
        out = { statusCode: '0000', transactionStatus: 'Completed', refundTrxID: 'REALRF1' };
      }
      return new Response(JSON.stringify(out), { status: 200 });
    }) as typeof fetch);
    const grant = await request(app)
      .post('/v2/tokenized-checkout/auth/grant-token')
      .set({ username: 'sim-merchant', password: 'sim-merchant-password' })
      .send({ app_key: 'sim-app-key', app_secret: 'sim-app-secret-key' });
    headers = { authorization: String(grant.body.id_token), 'x-app-key': 'sim-app-key' };
  });

  afterEach(() => setBkashFetch(null));

  it('create -> provider callback -> execute -> refund all reach the provider', async () => {
    const created = await request(app)
      .post('/v2/tokenized-checkout/payment/create')
      .set(headers)
      .send({
        payerReference: '01770618575',
        callbackURL: 'http://client.test/bkash/cb',
        amount: '120',
        currency: 'BDT',
        intent: 'sale',
        merchantInvoiceNumber: 'INV-REAL-1',
      });
    expect(created.body.paymentId).toBe('TR0011REAL1');
    expect(created.body.bkashURL).toContain('sandbox.payment.bkash.com');
    const createCall = calls.find((c) => c.path === '/create')!;
    expect(createCall.body['callbackURL']).toMatch(/\/bkash\/sandbox\/callback$/);
    expect(createCall.auth).toBe('real-token-1');

    const back = await request(app)
      .get('/bkash/sandbox/callback')
      .query({ paymentID: 'TR0011REAL1', status: 'success', signature: 'x' });
    expect(back.text).toContain(
      'http://client.test/bkash/cb?paymentID=TR0011REAL1&amp;status=success',
    );

    const exec = await request(app)
      .post('/v2/tokenized-checkout/payment/execute')
      .set(headers)
      .send({ paymentId: 'TR0011REAL1' });
    expect(exec.body.trxId).toBe('REALTRX1');
    expect(fakes.stores.txns[0]!.state).toBe('completed');

    const refund = await request(app)
      .post('/v2/tokenized-checkout/refund/payment/transaction')
      .set(headers)
      .send({ paymentId: 'TR0011REAL1', trxId: 'REALTRX1', refundAmount: '20', reason: 'test' });
    expect(refund.body.refundTransactionStatus).toBe('Completed');
    const refundCall = calls.find((c) => c.path === '/payment/refund')!;
    expect(refundCall.body).toMatchObject({
      paymentID: 'TR0011REAL1',
      trxID: 'REALTRX1',
      amount: '20.00',
    });
    // Token cached: a single grant served create, execute and refund.
    expect(grants).toBe(1);

    // The public sandbox refund API allows one refund per payment.
    const second = await request(app)
      .post('/v2/tokenized-checkout/refund/payment/transaction')
      .set(headers)
      .send({ paymentId: 'TR0011REAL1', trxId: 'REALTRX1', refundAmount: '10', reason: 'again' });
    expect(JSON.stringify(second.body)).toContain('Process failed');
    expect(calls.filter((c) => c.path === '/payment/refund')).toHaveLength(1);
  });

  it('fails execute when the provider does not complete', async () => {
    setBkashFetch((async (input: string | URL | Request) => {
      const url = String(input);
      const out = url.endsWith('/token/grant')
        ? { statusCode: '0000', id_token: 't' }
        : url.endsWith('/create')
          ? {
              statusCode: '0000',
              paymentID: 'TR2',
              bkashURL: 'https://sandbox.payment.bkash.com/?p=TR2',
            }
          : { statusCode: '2056', statusMessage: 'Invalid Payment State' };
      return new Response(JSON.stringify(out), { status: 200 });
    }) as typeof fetch);
    await request(app).post('/v2/tokenized-checkout/payment/create').set(headers).send({
      payerReference: '01770618575',
      callbackURL: 'http://client.test/cb',
      amount: '50',
      currency: 'BDT',
      intent: 'sale',
      merchantInvoiceNumber: 'INV-2',
    });
    await request(app)
      .get('/bkash/sandbox/callback')
      .query({ paymentID: 'TR2', status: 'success' });
    const exec = await request(app)
      .post('/v2/tokenized-checkout/payment/execute')
      .set(headers)
      .send({ paymentId: 'TR2' });
    expect(JSON.stringify(exec.body)).toContain('Invalid Payment State');
    expect(fakes.stores.txns[0]!.state).toBe('failed');
  });
});
