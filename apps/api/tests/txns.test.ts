import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createTxnsRouter } from '../src/routes/transactions.js';
import type { Queries } from '../src/stores/drizzle-stores.js';
import type { TxnOpsDeps } from '../src/txn-ops.js';

describe('txns routes', () => {
  function makeApp(queries: Partial<Queries>): express.Application {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/txns',
      createTxnsRouter({ queries: queries as Queries, ops: {} as unknown as TxnOpsDeps }),
    );
    return app;
  }

  const workspace = { id: 'ws-1', key: 'local-default', name: 'Local' };

  it('lists with filters and caps limit', async () => {
    const listTransactions = vi.fn(async () => []);
    const app = makeApp({
      getWorkspaceByKey: async () => workspace,
      listTransactions,
    });
    const res = await request(app).get(
      '/api/txns?workspace=local-default&gateway=sslcommerz&limit=5',
    );
    expect(res.status).toBe(200);
    expect(listTransactions).toHaveBeenCalledWith({
      workspaceKey: 'local-default',
      gateway: 'sslcommerz',
      state: undefined,
      limit: 5,
    });
  });

  it('rejects bad limits and unknown workspaces', async () => {
    const app = makeApp({
      getWorkspaceByKey: async () => workspace,
      listTransactions: async () => [],
    });
    expect((await request(app).get('/api/txns?limit=9999')).status).toBe(400);
    const missing = makeApp({ getWorkspaceByKey: async () => null });
    expect((await request(missing).get('/api/txns')).status).toBe(404);
  });

  it('returns detail or 404', async () => {
    const detail = { txn: { id: 't1' }, events: [], deliveries: [] };
    const app = makeApp({ getTransactionDetail: async () => detail as never });
    const res = await request(app).get('/api/txns/t1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(detail);

    const empty = makeApp({ getTransactionDetail: async () => null });
    expect((await request(empty).get('/api/txns/nope')).status).toBe(404);
  });
});
