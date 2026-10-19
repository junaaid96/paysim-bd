import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { ScenarioDefinitionSchema } from '@paysim/core';

import { createBkashRouter } from '../src/routes.js';
import { makeCtx, type FakeContext } from './fakes.js';

const CREATE = {
  payerReference: 'TEST001ABC',
  callbackURL: 'https://merchant.test/cb',
  amount: '150.75',
  currency: 'BDT',
  intent: 'sale',
  merchantInvoiceNumber: 'INV-S1',
};

describe('bkash scenario selection on create', () => {
  let fakes: FakeContext;
  let app: express.Application;
  let token: string;

  beforeEach(async () => {
    fakes = makeCtx();
    fakes.stores.seedApp();
    app = express();
    app.use(express.json());
    app.use(createBkashRouter(fakes.ctx));
    const granted = await request(app)
      .post('/v2/tokenized-checkout/auth/grant-token')
      .set({ username: 'sim-merchant', password: 'sim-merchant-password' })
      .send({ app_key: 'sim-app-key', app_secret: 'sim-app-secret-key' });
    expect(granted.body.statusCode).toBe('0000');
    token = String(granted.body.id_token);
  });

  function authHeaders(): Record<string, string> {
    return { authorization: token, 'x-app-key': 'sim-app-key' };
  }

  it('attaches the SIM: magic scenario from merchantInvoiceNumber', async () => {
    const res = await request(app)
      .post('/v2/tokenized-checkout/payment/create')
      .set(authHeaders())
      .send({ ...CREATE, merchantInvoiceNumber: 'SIM:immediate-success' });
    expect(res.status).toBe(200);
    expect(res.body.transactionStatus).toBe('Initiated');
    expect(fakes.attached).toHaveLength(1);
    expect(fakes.attached[0]).toMatchObject({
      source: 'magic',
      scenarioId: null,
      definition: { name: 'immediate-success' },
    });
  });

  it('fails the create loudly on an unknown SIM: name, writing no rows', async () => {
    const res = await request(app)
      .post('/v2/tokenized-checkout/payment/create')
      .set(authHeaders())
      .send({ ...CREATE, merchantInvoiceNumber: 'SIM:nope' });
    expect(res.status).toBe(200);
    expect(res.body.externalCode).toBe('2003');
    expect(String(res.body.errorMessageEn)).toContain('Unknown scenario: nope');
    expect(fakes.stores.txns).toHaveLength(0);
    expect(fakes.attached).toHaveLength(0);
  });

  it('falls back to the app default scenario', async () => {
    fakes.stores.apps[0]!.defaultScenarioId = 'scn-1';
    fakes.stores.seedScenario(
      'scn-1',
      ScenarioDefinitionSchema.parse({ name: 'custom', steps: [{ action: 'redirect_success' }] }),
    );
    const res = await request(app)
      .post('/v2/tokenized-checkout/payment/create')
      .set(authHeaders())
      .send(CREATE);
    expect(res.body.transactionStatus).toBe('Initiated');
    expect(fakes.attached[0]).toMatchObject({ source: 'default', scenarioId: 'scn-1' });
  });

  it('magic beats the app default', async () => {
    fakes.stores.apps[0]!.defaultScenarioId = 'scn-1';
    fakes.stores.seedScenario(
      'scn-1',
      ScenarioDefinitionSchema.parse({ name: 'custom', steps: [] }),
    );
    const res = await request(app)
      .post('/v2/tokenized-checkout/payment/create')
      .set(authHeaders())
      .send({ ...CREATE, merchantInvoiceNumber: 'SIM:immediate-fail' });
    expect(res.body.transactionStatus).toBe('Initiated');
    expect(fakes.attached[0]).toMatchObject({
      source: 'magic',
      definition: { name: 'immediate-fail' },
    });
  });
});
