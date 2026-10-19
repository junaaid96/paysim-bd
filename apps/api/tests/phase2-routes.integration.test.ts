// Phase 2 dashboard routes over HTTP: clock, scenarios, app defaults,
// txn overrides and replays. Needs TEST_DATABASE_URL (serial).

import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BusMessage } from '../src/events/bus.js';
import { createAppsRouter } from '../src/routes/apps.js';
import { createClockRouter } from '../src/routes/clock.js';
import { createScenariosRouter } from '../src/routes/scenarios.js';
import { createTxnsRouter } from '../src/routes/transactions.js';
import { createScenario } from '../src/scenarios.js';
import { ScenarioDefinitionSchema } from '@paysim/core';
import { createTestHost, startReceiver, type TestHost, type TestReceiver } from './host-harness.js';

const TEST_URL = process.env['TEST_DATABASE_URL'];
const maybe = TEST_URL ? describe : describe.skip;

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

maybe('phase 2 routes', () => {
  let host: TestHost;
  let app: express.Application;
  let receiver: TestReceiver;

  beforeAll(async () => {
    host = await createTestHost();
    app = express();
    app.use(express.json());
    app.use(
      '/api/clock',
      createClockRouter({
        db: host.db,
        clock: host.clock,
        queries: host.queries,
        bus: host.bus,
        kick: host.kick,
      }),
    );
    app.use(
      '/api/scenarios',
      createScenariosRouter({ db: host.db, queries: host.queries, plugins: host.plugins }),
    );
    app.use('/api/txns', createTxnsRouter({ queries: host.queries, ops: host.ops }));
    app.use(
      '/api/apps',
      createAppsRouter({
        db: host.db,
        plugins: host.plugins,
        queries: host.queries,
        stores: host.stores,
      }),
    );
    receiver = await startReceiver();
  }, 60_000);

  afterAll(async () => {
    await receiver.close();
    await host.cleanup();
  });

  describe('clock', () => {
    it('gets, advances, sets and resets with shift counts', async () => {
      const seen: BusMessage[] = [];
      const unsub = host.bus.subscribe('local-default', (message) => seen.push(message));
      try {
        const initial = await request(app).get('/api/clock?workspace=local-default');
        expect(initial.status).toBe(200);
        expect(initial.body.offsetMs).toBe(0);
        expect(Number.isNaN(Date.parse(initial.body.now as string))).toBe(false);

        const advanced = await request(app).post('/api/clock/advance').send({ ms: 5000 });
        expect(advanced.status).toBe(200);
        expect(advanced.body.offsetMs).toBe(5000);
        expect(advanced.body.jobsShifted).toBe(0);
        expect(seen.map((message) => message.type)).toContain('clock.changed');

        const target = new Date(Date.now() + 3_600_000).toISOString();
        const set = await request(app).put('/api/clock').send({ now: target });
        expect(set.status).toBe(200);
        expect(Math.abs(Date.parse(set.body.now as string) - Date.parse(target))).toBeLessThan(
          5000,
        );

        const reset = await request(app).post('/api/clock/reset').send({});
        expect(reset.status).toBe(200);
        expect(reset.body.offsetMs).toBe(0);
      } finally {
        unsub();
      }
    });

    it('rejects bad input and unknown workspaces', async () => {
      expect((await request(app).get('/api/clock?workspace=nope')).status).toBe(404);
      expect((await request(app).post('/api/clock/advance').send({ ms: 'x' })).status).toBe(400);
      expect(
        (
          await request(app)
            .post('/api/clock/advance')
            .send({ ms: 10 ** 15 })
        ).status,
      ).toBe(400);
      expect((await request(app).put('/api/clock').send({ now: 'not-a-date' })).status).toBe(400);
      expect(
        (await request(app).post('/api/clock/reset').send({ workspaceKey: 'nope' })).status,
      ).toBe(404);
    });
  });

  describe('scenarios', () => {
    it('lists globals with flags and filters by gateway', async () => {
      const res = await request(app).get('/api/scenarios?workspace=local-default');
      expect(res.status).toBe(200);
      const names = (res.body as Array<{ name: string; global: boolean }>).map((row) => row.name);
      expect(names).toContain('immediate-success');
      expect(res.body.every((row: { global: boolean }) => row.global)).toBe(true);

      const filtered = await request(app).get(
        '/api/scenarios?workspace=local-default&gateway=sslcommerz',
      );
      expect(filtered.status).toBe(200);
      expect((await request(app).get('/api/scenarios?workspace=nope')).status).toBe(404);
      expect(
        (await request(app).get('/api/scenarios?workspace=local-default&gateway=nope')).status,
      ).toBe(400);
    });

    it('creates, reads, renames and deletes workspace scenarios', async () => {
      const created = await request(app)
        .post('/api/scenarios')
        .send({
          gateway: 'sslcommerz',
          name: 'route-case',
          definition: { name: 'route-case', steps: [{ action: 'redirect_success' }] },
        });
      expect(created.status).toBe(201);
      expect(created.body.global).toBe(false);
      const id = created.body.id as string;

      const duplicate = await request(app)
        .post('/api/scenarios')
        .send({
          gateway: 'sslcommerz',
          name: 'route-case',
          definition: { name: 'route-case', steps: [] },
        });
      expect(duplicate.status).toBe(409);

      const badAction = await request(app)
        .post('/api/scenarios')
        .send({
          gateway: 'sslcommerz',
          name: 'bad-case',
          definition: { name: 'bad-case', steps: [{ action: 'nope' }] },
        });
      expect(badAction.status).toBe(400);

      const unknownGateway = await request(app)
        .post('/api/scenarios')
        .send({
          gateway: 'nope',
          name: 'x',
          definition: { name: 'x', steps: [] },
        });
      expect(unknownGateway.status).toBe(400);

      const read = await request(app).get(`/api/scenarios/${id}`);
      expect(read.status).toBe(200);
      expect(read.body.name).toBe('route-case');
      expect((await request(app).get('/api/scenarios/not-a-uuid')).status).toBe(400);
      expect((await request(app).get(`/api/scenarios/${NIL_UUID}`)).status).toBe(404);

      const renamed = await request(app)
        .patch(`/api/scenarios/${id}`)
        .send({ name: 'route-renamed' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.name).toBe('route-renamed');
      expect((await request(app).patch(`/api/scenarios/${id}`).send({})).status).toBe(400);

      const deleted = await request(app).delete(`/api/scenarios/${id}`);
      expect(deleted.status).toBe(200);
      expect((await request(app).get(`/api/scenarios/${id}`)).status).toBe(404);
    });

    it('keeps builtins read-only', async () => {
      const list = (await request(app).get('/api/scenarios?workspace=local-default').expect(200))
        .body as Array<{ id: string; name: string }>;
      const builtin = list.find((row) => row.name === 'manual');
      expect(builtin).toBeDefined();
      expect(
        (await request(app).patch(`/api/scenarios/${builtin?.id}`).send({ name: 'x' })).status,
      ).toBe(403);
      expect((await request(app).delete(`/api/scenarios/${builtin?.id}`)).status).toBe(403);
    });
  });

  describe('apps', () => {
    it('sets and clears the default scenario', async () => {
      const custom = await createScenario(host.db, {
        workspaceId: host.workspace.id,
        gateway: 'sslcommerz',
        name: 'app-default-case',
        definition: ScenarioDefinitionSchema.parse({ name: 'app-default-case', steps: [] }),
      });
      const set = await request(app)
        .patch(`/api/apps/${host.app.id}`)
        .send({ defaultScenarioId: custom.id });
      expect(set.status).toBe(200);
      expect(set.body.defaultScenarioId).toBe(custom.id);

      const cleared = await request(app)
        .patch(`/api/apps/${host.app.id}`)
        .send({ defaultScenarioId: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.defaultScenarioId).toBeNull();

      expect(
        (await request(app).patch('/api/apps/not-a-uuid').send({ defaultScenarioId: null })).status,
      ).toBe(400);
      expect(
        (await request(app).patch(`/api/apps/${NIL_UUID}`).send({ defaultScenarioId: null }))
          .status,
      ).toBe(404);
      expect(
        (await request(app).patch(`/api/apps/${host.app.id}`).send({ defaultScenarioId: NIL_UUID }))
          .status,
      ).toBe(404);
    });

    it('rejects cross-gateway defaults', async () => {
      const foreign = await createScenario(host.db, {
        workspaceId: host.workspace.id,
        gateway: 'nagad',
        name: 'foreign-case',
        definition: ScenarioDefinitionSchema.parse({ name: 'foreign-case', steps: [] }),
      });
      const res = await request(app)
        .patch(`/api/apps/${host.app.id}`)
        .send({ defaultScenarioId: foreign.id });
      expect(res.status).toBe(400);
    });
  });

  describe('txn scenario + replay', () => {
    it('attaches and detaches overrides', async () => {
      const custom = await createScenario(host.db, {
        workspaceId: host.workspace.id,
        gateway: 'sslcommerz',
        name: 'txn-override-case',
        definition: ScenarioDefinitionSchema.parse({
          name: 'txn-override-case',
          steps: [{ delayMs: 60_000, action: 'redirect_success' }],
        }),
      });
      const txn = await host.seedTxn({ ipnUrl: receiver.url });
      const attached = await request(app)
        .post(`/api/txns/${txn.id}/scenario`)
        .send({ scenarioId: custom.id });
      expect(attached.status).toBe(200);
      expect(attached.body.scenarioOverrideId).toBe(custom.id);

      const detached = await request(app)
        .post(`/api/txns/${txn.id}/scenario`)
        .send({ scenarioId: null });
      expect(detached.status).toBe(200);
      expect(detached.body.scenarioOverrideId).toBeNull();

      expect(
        (await request(app).post(`/api/txns/${txn.id}/scenario`).send({ scenarioId: NIL_UUID }))
          .status,
      ).toBe(404);
      expect(
        (await request(app).post('/api/txns/not-a-uuid/scenario').send({ scenarioId: null }))
          .status,
      ).toBe(400);
      expect(
        (await request(app).post(`/api/txns/${NIL_UUID}/scenario`).send({ scenarioId: null }))
          .status,
      ).toBe(404);
    });

    it('refuses overrides on terminal transactions', async () => {
      const custom = await createScenario(host.db, {
        workspaceId: host.workspace.id,
        gateway: 'sslcommerz',
        name: 'terminal-case',
        definition: ScenarioDefinitionSchema.parse({ name: 'terminal-case', steps: [] }),
      });
      const txn = await host.seedTxn({ state: 'valid' });
      const res = await request(app)
        .post(`/api/txns/${txn.id}/scenario`)
        .send({ scenarioId: custom.id });
      expect(res.status).toBe(422);
    });

    it('replays the latest delivery by default', async () => {
      const txn = await host.seedTxn({ ipnUrl: receiver.url });
      await host.stores.recordDelivery({
        workspaceId: txn.workspaceId,
        transactionId: txn.id,
        kind: 'ipn',
        targetUrl: receiver.url,
        status: 'failed',
        requestBody: 'tran_id=REPLAY-1&status=VALID',
      });
      const before = receiver.posts.length;
      const res = await request(app).post(`/api/txns/${txn.id}/replay`).send({});
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('delivered');
      expect(res.body.attemptNo).toBe(2);
      expect(receiver.posts.length).toBe(before + 1);
      expect(receiver.posts[receiver.posts.length - 1]?.fields['tran_id']).toBe('REPLAY-1');

      const empty = await host.seedTxn({ ipnUrl: receiver.url });
      expect((await request(app).post(`/api/txns/${empty.id}/replay`).send({})).status).toBe(404);
      expect(
        (await request(app).post(`/api/txns/${txn.id}/replay`).send({ deliveryId: NIL_UUID }))
          .status,
      ).toBe(404);
      expect((await request(app).post(`/api/txns/${NIL_UUID}/replay`).send({})).status).toBe(404);
    });
  });
});
