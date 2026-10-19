import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Application } from 'express';
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { SystemClock, type PluginStores, type ScenarioEngine } from '@paysim/core';

import { createApp } from '../src/app.js';
import type { DbClock } from '../src/clock.js';
import type { Db } from '../src/db/client.js';
import { EventBus } from '../src/events/bus.js';
import type { Queries } from '../src/stores/drizzle-stores.js';
import type { StorageAdapter } from '../src/storage/index.js';
import type { TxnOpsDeps } from '../src/txn-ops.js';
import { makeEnv } from './helpers.js';

function makeApp(
  options: { checkDb?: () => Promise<void>; webDistDir?: string } = {},
): Application {
  return createApp({
    env: makeEnv({ WEB_DIST_DIR: options.webDistDir ?? join(tmpdir(), 'paysim-no-such-dir') }),
    logger: pino({ level: 'silent' }),
    version: 'test-version',
    checkDb: options.checkDb ?? (async () => undefined),
    storage: {} as unknown as StorageAdapter,
    db: {} as unknown as Db,
    plugins: [],
    stores: {} as unknown as PluginStores,
    queries: { getWorkspaceByKey: async () => null } as unknown as Queries,
    bus: new EventBus(),
    clock: new SystemClock(),
    dbClock: new SystemClock() as unknown as DbClock,
    simBaseUrl: 'http://sim.test',
    deliverCallback: () => Promise.reject(new Error('deliverCallback not stubbed')),
    engine: {
      resolveForInit: () => Promise.reject(new Error('engine not stubbed')),
      attach: () => Promise.reject(new Error('engine not stubbed')),
    } as unknown as ScenarioEngine,
    ops: {} as unknown as TxnOpsDeps,
    kick: () => undefined,
  });
}

describe('health routes', () => {
  it('GET /api/health returns service identity', async () => {
    const res = await request(makeApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      service: 'paysim-api',
      version: 'test-version',
    });
    expect(Number.isNaN(Date.parse(res.body.now as string))).toBe(false);
  });

  it('GET /api/ready reflects database reachability', async () => {
    const ok = await request(makeApp()).get('/api/ready');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: 'ok', service: 'paysim-api' });

    const failing = makeApp({
      checkDb: () => Promise.reject(new Error('down')),
    });
    const degraded = await request(failing).get('/api/ready');
    expect(degraded.status).toBe(503);
    expect(degraded.body).toEqual({ status: 'degraded', service: 'paysim-api' });
  });

  it('unknown API routes 404 as JSON', async () => {
    const res = await request(makeApp()).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});

describe('dashboard static serving', () => {
  it('serves the built dashboard with an SPA fallback when present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'paysim-web-'));
    try {
      await writeFile(join(dir, 'index.html'), '<html>dashboard</html>');
      const app = makeApp({ webDistDir: dir });
      const root = await request(app).get('/');
      expect(root.status).toBe(200);
      expect(root.text).toContain('dashboard');
      const deep = await request(app).get('/transactions/123');
      expect(deep.status).toBe(200);
      expect(deep.text).toContain('dashboard');
      // API routes are unaffected by the fallback.
      expect((await request(app).get('/api/health')).status).toBe(200);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs API-only when the dashboard has not been built', async () => {
    const res = await request(makeApp()).get('/');
    expect(res.status).toBe(404);
  });
});
