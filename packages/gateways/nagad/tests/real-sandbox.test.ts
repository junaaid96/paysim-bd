// Nagad real-sandbox mode with a MOCKED Nagad sandbox (no network). The
// mock decrypts with a generated "Nagad" key pair and answers sealed for a
// generated merchant key pair, exactly like the documented flow.
import { generateKeyPairSync } from 'node:crypto';

import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rsaDecrypt, rsaEncrypt, rsaSign, rsaVerify } from '../src/crypto.js';
import { loadFixtureKeys } from '../src/fixtures.js';
import { setNagadFetch } from '../src/real.js';
import { createNagadRouter } from '../src/routes.js';
import { makeCtx, type FakeContext } from './fakes.js';

const BASE = '/remote-payment-gateway-1.0/api/dfs';
const MID = 'SIM-MERCHANT-001';
const fixture = loadFixtureKeys();
const pair = (): { pub: string; priv: string } => {
  const k = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    pub: k.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
};
const nagad = pair();
const merchant = pair();

function sealReq(payload: Record<string, unknown>): Record<string, string> {
  const t = JSON.stringify(payload);
  return {
    dateTime: '20261022120000',
    sensitiveData: rsaEncrypt(fixture.publicPem, t),
    signature: rsaSign(fixture.merchantPrivatePem, t),
  };
}
function openSim(body: Record<string, string>): Record<string, unknown> {
  return JSON.parse(rsaDecrypt(fixture.merchantPrivatePem, body['sensitiveData']!)) as Record<
    string,
    unknown
  >;
}

describe('nagad real-sandbox mode (mocked Nagad sandbox)', () => {
  let fakes: FakeContext;
  let app: express.Application;
  let calls: { url: string; plain: Record<string, unknown> | null }[];
  let verifyStatus: string;

  beforeEach(() => {
    calls = [];
    verifyStatus = 'Success';
    fakes = makeCtx();
    fakes.stores.seedApp({
      sandbox: {
        mode: 'real',
        keys: {
          merchant_id: '683002007104225',
          merchant_private_key: merchant.priv,
          nagad_public_key: nagad.pub,
        },
      },
    });
    app = express();
    app.use(express.json());
    app.use(createNagadRouter(fakes.ctx));
    setNagadFetch((async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
      let plain: Record<string, unknown> | null = null;
      if (body['sensitiveData']) {
        const t = rsaDecrypt(nagad.priv, body['sensitiveData']);
        expect(rsaVerify(merchant.pub, t, body['signature']!)).toBe(true);
        plain = JSON.parse(t) as Record<string, unknown>;
      }
      calls.push({ url, plain });
      const sealOut = (o: Record<string, unknown>): Record<string, string> => {
        const t = JSON.stringify(o);
        return { sensitiveData: rsaEncrypt(merchant.pub, t), signature: rsaSign(nagad.priv, t) };
      };
      let out: unknown = {};
      if (url.includes('/check-out/initialize/'))
        out = sealOut({ paymentReferenceId: 'NGREAL1', challenge: 'realchallenge' });
      else if (url.includes('/check-out/complete/'))
        out = { status: 'Success', callBackUrl: 'http://sandbox.mynagad.com:10707/check-out/MDEx' };
      else if (url.includes('/verify/payment/'))
        out = { status: verifyStatus, amount: '150.00', issuerPaymentRefNo: 'NGISSUER1' };
      else if (url.includes('/purchase/cancel'))
        out = sealOut({ status: 'Success', cancelTrxId: 'NGCANCEL1' });
      return new Response(JSON.stringify(out), { status: 200 });
    }) as typeof fetch);
  });
  afterEach(() => setNagadFetch(null));

  async function start(): Promise<{
    ref: string;
    challenge: string;
    callBackUrl: string;
    txnId: string;
  }> {
    const init = await request(app)
      .post(`${BASE}/check-out/initialize/${MID}/ORD-1`)
      .send(sealReq({ merchantId: MID, orderId: 'ORD-1', challenge: 'c'.repeat(40) }));
    const opened = openSim(init.body);
    const ref = String(opened['paymentReferenceId']);
    const challenge = String(opened['challenge']);
    const done = await request(app)
      .post(`${BASE}/check-out/complete/${ref}`)
      .send({
        ...sealReq({ merchantId: MID, orderId: 'ORD-1', amount: '150.00', challenge }),
        merchantCallbackURL: 'http://client.test/nagad/cb',
        additionalMerchantInfo: {},
      });
    return {
      ref,
      challenge,
      callBackUrl: String(done.body.callBackUrl),
      txnId: fakes.stores.txns[0]!.id,
    };
  }

  it('re-seals initialize/complete for Nagad, verifies on return, and refunds at Nagad', async () => {
    const { callBackUrl, txnId, ref } = await start();
    expect(callBackUrl).toContain('sandbox.mynagad.com');
    const initCall = calls.find((c) => c.url.includes('/initialize/'))!;
    expect(initCall.url).toContain('/683002007104225/PS');
    expect(initCall.plain).toMatchObject({ merchantId: '683002007104225' });
    const completeCall = calls.find((c) => c.url.includes('/complete/NGREAL1'))!;
    expect(completeCall.plain).toMatchObject({
      amount: '150.00',
      challenge: 'realchallenge',
      currencyCode: '050',
    });

    const back = await request(app)
      .get(`/nagad/sandbox/callback/${txnId}`)
      .query({ payment_ref_id: 'NGREAL1', status: 'Success' });
    expect(back.text).toContain('http://client.test/nagad/cb');
    const paid = fakes.stores.txns[0]!;
    expect(paid.state).toBe('success');
    expect(paid.metadata['trxId']).toBe('NGISSUER1');

    const verify = await request(app).get(`${BASE}/verify/payment/${ref}`);
    expect(verify.body.status).toBe('Success');

    const { settleRealRefund } = await import('../src/real.js');
    const result = await settleRealRefund(fakes.ctx, paid, fakes.stores.apps[0]!, {
      amountMinor: 5000,
      reason: 'r',
      refundId: 'NGRF1',
    });
    expect(result).toMatchObject({ ok: true, providerRefundId: 'NGCANCEL1' });
    expect(calls.find((c) => c.url.includes('/purchase/cancel'))!.plain).toMatchObject({
      cancelAmount: '50.00',
      originalAmount: '150.00',
    });
  });

  it('never trusts the redirect: a failed verify fails the payment', async () => {
    verifyStatus = 'Aborted';
    const { txnId } = await start();
    const back = await request(app)
      .get(`/nagad/sandbox/callback/${txnId}`)
      .query({ status: 'Success' });
    expect(back.text).toContain('status=Cancel');
    expect(fakes.stores.txns[0]!.state).toBe('cancelled');
  });
});
