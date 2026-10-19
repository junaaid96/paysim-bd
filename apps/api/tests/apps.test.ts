import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AppRecord, PluginStores } from '@paysim/core';
import { sslcommerzPlugin } from '@paysim/gateway-sslcommerz';

import type { Db } from '../src/db/client.js';
import { createAppsRouter } from '../src/routes/apps.js';
import type { Queries } from '../src/stores/drizzle-stores.js';

describe('apps routes', () => {
  const apps: AppRecord[] = [];
  let app: express.Application;

  const queries = {
    getWorkspaceByKey: async (key: string) =>
      key === 'local-default' ? { id: 'ws-1', key, name: 'Local' } : null,
    createApp: async (input: {
      workspaceId: string;
      gateway: string;
      name: string;
      credentials: Record<string, unknown>;
    }) => {
      const record: AppRecord = {
        id: `app-${apps.length + 1}`,
        workspaceId: input.workspaceId,
        workspaceKey: 'local-default',
        gateway: input.gateway,
        name: input.name,
        credentials: input.credentials,
        defaultScenarioId: null,
      };
      apps.push(record);
      return record;
    },
    listApps: async () => [...apps],
  } as unknown as Queries;

  const stores = {
    findAppByStoreId: async (gateway: string, field: string, value: string) =>
      apps.find(
        (candidate) => candidate.gateway === gateway && candidate.credentials[field] === value,
      ) ?? null,
  } as unknown as PluginStores;

  beforeEach(() => {
    apps.length = 0;
    app = express();
    app.use(express.json());
    app.use(
      '/api/apps',
      createAppsRouter({ db: {} as Db, plugins: [sslcommerzPlugin], queries, stores }),
    );
  });

  it('creates apps with validated fake credentials', async () => {
    const res = await request(app)
      .post('/api/apps')
      .send({
        gateway: 'sslcommerz',
        name: 'Test store',
        credentials: { store_id: 'testbox', store_passwd: 'qwerty' },
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ gateway: 'sslcommerz', name: 'Test store' });

    const list = await request(app).get('/api/apps?workspace=local-default');
    expect(list.body).toHaveLength(1);
  });

  it('rejects duplicates, production refs, bad shapes and unknown gateways', async () => {
    await request(app)
      .post('/api/apps')
      .send({
        gateway: 'sslcommerz',
        name: 'A',
        credentials: { store_id: 'testbox', store_passwd: 'qwerty' },
      });
    const duplicate = await request(app)
      .post('/api/apps')
      .send({
        gateway: 'sslcommerz',
        name: 'B',
        credentials: { store_id: 'testbox', store_passwd: 'other' },
      });
    expect(duplicate.status).toBe(409);

    const production = await request(app)
      .post('/api/apps')
      .send({
        gateway: 'sslcommerz',
        name: 'C',
        credentials: { store_id: 'testbox', store_passwd: 'https://securepay.sslcommerz.com/x' },
      });
    expect(production.status).toBe(422);

    const badShape = await request(app)
      .post('/api/apps')
      .send({
        gateway: 'sslcommerz',
        name: 'D',
        credentials: { store_id: 'x' },
      });
    expect(badShape.status).toBe(400);

    const unknownGateway = await request(app).post('/api/apps').send({
      gateway: 'nope',
      name: 'E',
      credentials: {},
    });
    expect(unknownGateway.status).toBe(400);
  });

  it('404s unknown workspaces', async () => {
    expect((await request(app).get('/api/apps?workspace=nope')).status).toBe(404);
  });
});
