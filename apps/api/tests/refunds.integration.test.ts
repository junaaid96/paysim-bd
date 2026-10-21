// Dashboard refunds over HTTP plus the atomic store guard under
// concurrency. Needs TEST_DATABASE_URL (serial).

import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { refundLedger } from '@paysim/core';

import { createTxnsRouter } from '../src/routes/transactions.js';
import { createTestHost, type TestHost } from './host-harness.js';

const TEST_URL = process.env['TEST_DATABASE_URL'];
const maybe = TEST_URL ? describe : describe.skip;

maybe('refunds', () => {
  let host: TestHost;
  let app: express.Application;

  beforeAll(async () => {
    host = await createTestHost();
    app = express();
    app.use(express.json());
    app.use('/api/txns', createTxnsRouter({ queries: host.queries, ops: host.ops }));
  }, 60_000);

  afterAll(async () => {
    await host.cleanup();
  });

  it('refunds partially, fully, idempotently and never over-refunds', async () => {
    const txn = await host.seedTxn({ state: 'valid' });
    const total = txn.amountMinor;
    const part = Math.floor(total / 4);
    const first = await request(app)
      .post(`/api/txns/${txn.id}/refunds`)
      .send({ amountMinor: part, reason: 'damaged', idempotencyKey: 'k-1' });
    expect(first.status).toBe(201);
    expect(first.body.ledger).toMatchObject({ refundedMinor: part, refundStatus: 'partial' });
    const replay = await request(app)
      .post(`/api/txns/${txn.id}/refunds`)
      .send({ amountMinor: part, reason: 'damaged', idempotencyKey: 'k-1' });
    expect(replay.status).toBe(200);
    expect(replay.body.refund.refundId).toBe(first.body.refund.refundId);
    const conflict = await request(app)
      .post(`/api/txns/${txn.id}/refunds`)
      .send({ amountMinor: part + 1, idempotencyKey: 'k-1' });
    expect(conflict.status).toBe(409);
    const over = await request(app)
      .post(`/api/txns/${txn.id}/refunds`)
      .send({ amountMinor: total });
    expect(over.status).toBe(422);
    expect(over.body.error).toBe('exceeds_refundable');
    const declined = await request(app)
      .post(`/api/txns/${txn.id}/refunds`)
      .send({ amountMinor: 1, simulateFailure: true });
    expect(declined.body.refund.status).toBe('failed');
    const rest = await request(app)
      .post(`/api/txns/${txn.id}/refunds`)
      .send({ amountMinor: total - part });
    expect(rest.body.ledger).toMatchObject({ refundStatus: 'full', refundableMinor: 0 });
    const detail = await request(app).get(`/api/txns/${txn.id}`);
    const types = (detail.body.events as { type: string }[]).map((event) => event.type);
    expect(types).toContain('sslcommerz.refund.completed');
    expect(types).toContain('sslcommerz.refund.failed');
    expect(detail.body.txn.state).toBe('valid');
  });

  it('rejects refunds on unpaid payments', async () => {
    const txn = await host.seedTxn({ state: 'failed' });
    const res = await request(app).post(`/api/txns/${txn.id}/refunds`).send({ amountMinor: 100 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('not_refundable');
  });

  it('holds the balance under concurrent refunds', async () => {
    const txn = await host.seedTxn({ state: 'valid' });
    const each = Math.ceil(txn.amountMinor / 3);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(app).post(`/api/txns/${txn.id}/refunds`).send({ amountMinor: each }),
      ),
    );
    const ok = results.filter((res) => res.status === 201).length;
    expect(ok).toBe(Math.floor(txn.amountMinor / each));
    const fresh = await host.stores.getTransaction(txn.id);
    const ledger = refundLedger(fresh!);
    expect(ledger.refundedMinor).toBeLessThanOrEqual(txn.amountMinor);
    expect(fresh?.metadata['refundedMinor']).toBe(ledger.refundedMinor);
  });
});
