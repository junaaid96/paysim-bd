import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { ScenarioDefinitionSchema } from '@paysim/core';

import { rsaDecrypt, rsaEncrypt, rsaSign } from '../src/crypto.js';
import { loadFixtureKeys } from '../src/fixtures.js';
import { createNagadRouter } from '../src/routes.js';
import { makeCtx, type FakeContext } from './fakes.js';

const GATEWAY_BASE = '/remote-payment-gateway-1.0/api/dfs';
const MERCHANT_ID = 'SIM-MERCHANT-001';
const fixture = loadFixtureKeys();

function sealRequest(payload: Record<string, unknown>): Record<string, string> {
  const plaintext = JSON.stringify(payload);
  return {
    dateTime: '20260101120000',
    sensitiveData: rsaEncrypt(fixture.publicPem, plaintext),
    signature: rsaSign(fixture.merchantPrivatePem, plaintext),
  };
}

describe('nagad scenario selection', () => {
  let fakes: FakeContext;
  let app: express.Application;

  beforeEach(() => {
    fakes = makeCtx();
    fakes.stores.seedApp();
    app = express();
    app.use(express.json());
    app.use(createNagadRouter(fakes.ctx));
  });

  async function initialize(
    orderId: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await request(app)
      .post(`${GATEWAY_BASE}/check-out/initialize/${MERCHANT_ID}/${orderId}`)
      .send(sealRequest({ merchantId: MERCHANT_ID, orderId, challenge: 'a'.repeat(40) }));
    return { status: res.status, body: res.body as Record<string, unknown> };
  }

  async function completeWithMagic(orderId: string): Promise<void> {
    const init = await initialize(orderId);
    expect(init.status).toBe(200);
    const opened = JSON.parse(
      rsaDecrypt(
        fixture.merchantPrivatePem,
        String((init.body as { sensitiveData: string }).sensitiveData),
      ),
    ) as { paymentReferenceId: string; challenge: string };
    const res = await request(app)
      .post(`${GATEWAY_BASE}/check-out/complete/${opened.paymentReferenceId}`)
      .send({
        ...sealRequest({
          merchantId: MERCHANT_ID,
          orderId,
          amount: '100.00',
          challenge: opened.challenge,
        }),
        merchantCallbackURL: 'https://merchant.test/cb',
        additionalMerchantInfo: {},
      });
    expect(res.status).toBe(200);
  }

  it('validates magic at initialize, attaches the scenario at complete', async () => {
    await completeWithMagic('SIM:immediate-success');
    expect(fakes.attached).toHaveLength(2);
    expect(fakes.attached[0]).toMatchObject({ source: 'manual' });
    expect(fakes.attached[1]).toMatchObject({
      source: 'magic',
      definition: { name: 'immediate-success' },
    });
  });

  it('accepts suffixed magic order ids for repeated runs', async () => {
    await completeWithMagic('SIM:immediate-fail:run-42');
    expect(fakes.attached[1]).toMatchObject({ definition: { name: 'immediate-fail' } });
  });

  it('fails initialize loudly on unknown SIM: names, writing no rows', async () => {
    const res = await initialize('SIM:nope');
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('Unknown scenario: nope');
    expect(fakes.stores.txns).toHaveLength(0);
    expect(fakes.attached).toHaveLength(0);
  });

  it('falls back to the app default at complete', async () => {
    fakes.stores.apps[0]!.defaultScenarioId = 'scn-1';
    fakes.stores.seedScenario(
      'scn-1',
      ScenarioDefinitionSchema.parse({ name: 'custom', steps: [{ action: 'redirect_success' }] }),
    );
    await completeWithMagic('ORDER-PLAIN-1');
    expect(fakes.attached[1]).toMatchObject({ source: 'default', scenarioId: 'scn-1' });
  });
});
