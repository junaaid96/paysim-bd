import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { ScenarioDefinitionSchema } from '@paysim/core';

import { createSslcommerzRouter } from '../src/routes.js';
import { makeCtx, type FakeContext } from './fakes.js';

const INIT = {
  store_id: 'testbox',
  store_passwd: 'qwerty',
  total_amount: '103',
  currency: 'BDT',
  tran_id: 'ORDER-S1',
  product_category: 'test',
  success_url: 'http://client.test/pay/success',
  fail_url: 'http://client.test/pay/fail',
  cancel_url: 'http://client.test/pay/cancel',
  ipn_url: 'http://client.test/pay/ipn',
};

describe('scenario selection on init', () => {
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

  it('attaches the SIM: magic scenario from value_d', async () => {
    const res = await request(app)
      .post('/gwprocess/v4/api.php')
      .send({ ...INIT, value_d: 'SIM:duplicate-ipn' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SUCCESS');
    expect(fakes.attached).toHaveLength(1);
    expect(fakes.attached[0]).toMatchObject({
      source: 'magic',
      scenarioId: null,
      definition: { name: 'duplicate-ipn' },
    });
  });

  it('fails the init loudly on an unknown SIM: name, writing no rows', async () => {
    const res = await request(app)
      .post('/gwprocess/v4/api.php')
      .send({ ...INIT, value_d: 'SIM:nope' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'FAILED', failedreason: 'Unknown scenario: nope' });
    expect(fakes.stores.txns).toHaveLength(0);
    expect(fakes.attached).toHaveLength(0);
  });

  it('treats a bare SIM: marker as absent (manual)', async () => {
    const res = await request(app)
      .post('/gwprocess/v4/api.php')
      .send({ ...INIT, value_d: 'SIM:' });
    expect(res.body.status).toBe('SUCCESS');
    expect(fakes.attached[0]).toMatchObject({ source: 'manual' });
  });

  it('falls back to the app default scenario', async () => {
    fakes.stores.apps[0]!.defaultScenarioId = 'scn-1';
    fakes.stores.seedScenario(
      'scn-1',
      ScenarioDefinitionSchema.parse({ name: 'custom', steps: [{ action: 'redirect_success' }] }),
    );
    const res = await request(app).post('/gwprocess/v4/api.php').send(INIT);
    expect(res.body.status).toBe('SUCCESS');
    expect(fakes.attached[0]).toMatchObject({ source: 'default', scenarioId: 'scn-1' });
  });

  it('magic beats the app default', async () => {
    fakes.stores.apps[0]!.defaultScenarioId = 'scn-1';
    fakes.stores.seedScenario(
      'scn-1',
      ScenarioDefinitionSchema.parse({ name: 'custom', steps: [] }),
    );
    const res = await request(app)
      .post('/gwprocess/v4/api.php')
      .send({ ...INIT, value_d: 'SIM:immediate-fail' });
    expect(res.body.status).toBe('SUCCESS');
    expect(fakes.attached[0]).toMatchObject({
      source: 'magic',
      definition: { name: 'immediate-fail' },
    });
  });
});
