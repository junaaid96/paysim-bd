import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rocketPlugin } from '../src/index.js';
import { setRocketFetch } from '../src/real.js';
import { createRocketRouter, INVALID_TXN, WRONG_MERCHANT } from '../src/routes.js';
import { parseResultLines, parseSoapReturn, soapRequest, soapResponse } from '../src/soap.js';
import { makeCtx, type FakeContext } from './fakes.js';

const CREDS = { userid: 'SIM-ROCKET-001', pwd: 'sim-rocket-pwd' };

function build(fakes: FakeContext): express.Application {
  const app = express();
  app.use(express.json());
  app.use(createRocketRouter(fakes.ctx));
  return app;
}

async function soap(
  app: express.Application,
  op: 'getransid' | 'getresult' | 'getresultrocket',
  fields: Record<string, string>,
): Promise<string> {
  const res = await request(app)
    .post('/ecomws/dbblecomtxn')
    .set('content-type', 'text/xml')
    .send(soapRequest(op, fields));
  expect(res.status).toBe(200);
  return parseSoapReturn(res.text) ?? '';
}

describe('rocket simulator', () => {
  let fakes: FakeContext;
  let app: express.Application;

  beforeEach(() => {
    fakes = makeCtx();
    fakes.stores.seedApp();
    app = build(fakes);
  });

  it('rejects wrong merchant and unknown transid like DBBL', async () => {
    expect(
      await soap(app, 'getransid', {
        userid: 'x',
        pwd: 'y',
        amount: '100',
        cardtype: '6',
        txnrefnum: 'A',
        clientip: '1.1.1.1',
      }),
    ).toBe(WRONG_MERCHANT);
    expect(await soap(app, 'getresult', { ...CREDS, transid: 'nope', clientip: '' })).toBe(
      INVALID_TXN,
    );
  });

  it('getransid -> wallet page -> success -> getresult OK', async () => {
    const raw = await soap(app, 'getransid', {
      ...CREDS,
      amount: '15000',
      cardtype: '6',
      txnrefnum: 'ORD-1',
      clientip: '1.1.1.1',
    });
    const transId = parseResultLines(raw)['TRANSACTION_ID']!;
    expect(transId).toHaveLength(28);
    const page = await request(app).get(
      `/ecomm2/ClientHandler?card_type=6&trans_id=${encodeURIComponent(transId)}`,
    );
    expect(page.status).toBe(200);
    expect(page.text).toContain('PaySim sandbox');
    expect(page.text).toContain('150.00');
    const done = await request(app)
      .post('/ecomm2/ClientHandler')
      .type('form')
      .send({ trans_id: transId, action: 'success', wallet: '01900000001' });
    expect(done.text).toContain('trans_id=');
    const result = parseResultLines(
      await soap(app, 'getresultrocket', { ...CREDS, transid: transId, clientip: '' }),
    );
    expect(result).toMatchObject({ RESULT: 'OK', RESULT_PS: 'FINISHED', RESULT_CODE: '000' });
    expect(fakes.stores.txns[0]!.amountMinor).toBe(15000);
  });

  it('cancel reports TIMEOUT/CANCELLED; duplicates are refused', async () => {
    const raw = await soap(app, 'getransid', {
      ...CREDS,
      amount: '100',
      cardtype: '6',
      txnrefnum: 'ORD-2',
      clientip: '',
    });
    const transId = parseResultLines(raw)['TRANSACTION_ID']!;
    await request(app)
      .post('/ecomm2/ClientHandler')
      .type('form')
      .send({ trans_id: transId, action: 'cancel' });
    expect(
      parseResultLines(await soap(app, 'getresult', { ...CREDS, transid: transId, clientip: '' }))[
        'RESULT'
      ],
    ).toBe('TIMEOUT');
    expect(
      await soap(app, 'getransid', {
        ...CREDS,
        amount: '100',
        cardtype: '6',
        txnrefnum: 'ORD-2',
        clientip: '',
      }),
    ).toMatch(/^error/);
  });

  it('refunds are ledger-only in the simulator', () => {
    expect(rocketPlugin.refundableStates).toEqual(['success']);
  });
});

describe('rocket real sandbox (mocked DBBL)', () => {
  afterEach(() => setRocketFetch(null));
  const KEYS = { userid: 'dbbl-user', pwd: 'dbbl-pwd', cardtype: '6' };

  it('needs userid, pwd and cardtype', () => {
    expect(rocketPlugin.sandbox?.validateKeys({ userid: 'a' }).ok).toBe(false);
    expect(rocketPlugin.sandbox?.validateKeys(KEYS).ok).toBe(true);
  });

  it('proxies getransid, redirects to DBBL and syncs the result', async () => {
    const ops: string[] = [];
    setRocketFetch((async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://ecomtest.dutchbanglabank.com/ecomws/dbblecomtxn');
      const body = String(init?.body);
      const op = /<ns2:(\w+)/.exec(body)![1]!;
      ops.push(op);
      expect(body).toContain('<userid>dbbl-user</userid>');
      const value =
        op === 'getransid'
          ? 'TRANSACTION_ID: REALID+abc='
          : 'RESULT: OK\nRESULT_PS: FINISHED\nRESULT_CODE: 000';
      return new Response(soapResponse(op, value), { status: 200 });
    }) as typeof fetch);
    const fakes = makeCtx();
    fakes.stores.seedApp({ sandbox: { mode: 'real', keys: KEYS } } as never);
    const app = build(fakes);
    const raw = await soap(app, 'getransid', {
      ...CREDS,
      amount: '100',
      cardtype: '6',
      txnrefnum: 'R-1',
      clientip: '',
    });
    expect(parseResultLines(raw)['TRANSACTION_ID']).toBe('REALID+abc=');
    const hop = await request(app).get(
      `/ecomm2/ClientHandler?trans_id=${encodeURIComponent('REALID+abc=')}`,
    );
    expect(hop.status).toBe(302);
    expect(hop.headers['location']).toBe(
      'https://ecomtest.dutchbanglabank.com/ecomm2/ClientHandler?card_type=6&trans_id=REALID%2Babc%3D',
    );
    expect(
      parseResultLines(
        await soap(app, 'getresult', { ...CREDS, transid: 'REALID+abc=', clientip: '' }),
      )['RESULT'],
    ).toBe('OK');
    expect(fakes.stores.txns[0]!.state).toBe('success');
    expect(ops).toEqual(['getransid', 'getresult']);
    const refund = await rocketPlugin.sandbox!.settleRefund!(
      fakes.ctx,
      fakes.stores.txns[0]!,
      fakes.stores.apps[0]!,
      { amountMinor: 100 } as never,
    );
    expect(refund.ok).toBe(false);
  });

  it('testConnection surfaces Wrong Merchant ID', async () => {
    setRocketFetch(
      (async () => new Response(soapResponse('getransid', 'Wrong Merchant ID'))) as typeof fetch,
    );
    const r = await rocketPlugin.sandbox!.testConnection!(
      makeCtx().ctx as never,
      null as never,
      KEYS,
    );
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toContain('Wrong Merchant ID');
  });
});
