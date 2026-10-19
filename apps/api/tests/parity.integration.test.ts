// Parity replay: every bundled fixture runs against the live stack
// (management API + plugin routers + real Postgres) and the badge rule is
// enforced — a "verified" claim without passing real-sandbox coverage
// fails this test. Needs TEST_DATABASE_URL (serial).

import { type Server } from 'node:http';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  discoverFixtures,
  evaluateBadges,
  loadBodyJson,
  runFixture,
  type FixtureResult,
  type GatewaySpecSummary,
} from '@paysim/parity';

import { createAppsRouter } from '../src/routes/apps.js';
import { createTxnsRouter } from '../src/routes/transactions.js';
import { createTestHost, type TestHost } from './host-harness.js';

const TEST_URL = process.env['TEST_DATABASE_URL'];
const maybe = TEST_URL ? describe : describe.skip;

const FIXTURES_DIR = fileURLToPath(new URL('../../../packages/parity/fixtures', import.meta.url));

maybe('parity replay', () => {
  let host: TestHost;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    host = await createTestHost();
    // Fixtures need app setup (POST /api/apps), txn lookup (GET /api/txns
    // for val_id capture) and the gateway routers.
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use(
      '/api/apps',
      createAppsRouter({
        db: host.db,
        plugins: host.plugins,
        queries: host.queries,
        stores: host.stores,
      }),
    );
    app.use('/api/txns', createTxnsRouter({ queries: host.queries, ops: host.ops }));
    for (const plugin of host.plugins) {
      app.use(plugin.createRouter(host.ctx) as unknown as express.Router);
    }
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('listen failed');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await host.cleanup();
  });

  it('replays every fixture green with no badge violations', async () => {
    const discovered = await discoverFixtures(FIXTURES_DIR);
    expect(discovered.length).toBeGreaterThan(0);

    const results: FixtureResult[] = [];
    for (const { fixture } of discovered) {
      const result = await runFixture(fixture, {
        baseUrl,
        workspaceKey: host.workspace.key,
        loadBody: (ref) => loadBodyJson(ref, { bodiesDir: FIXTURES_DIR }),
      });
      results.push(result);
    }

    for (const result of results) {
      expect(
        result.pass,
        `${result.gateway}/${result.name}: ${result.failures.map((f) => `${f.step}: ${f.message}\n${f.diffs.join('\n')}`).join('\n')}`,
      ).toBe(true);
    }

    // Badge enforcement over the gateways this suite covers: a "verified"
    // claim with only docs-sample evidence must fail loudly.
    const specs: GatewaySpecSummary[] = host.plugins
      .filter((plugin) => results.some((result) => result.gateway === plugin.name))
      .map((plugin) => ({
        gateway: plugin.name,
        claimed: plugin.spec.fidelity,
        implementedEndpoints: plugin.spec.endpoints
          .filter((endpoint) => endpoint.implemented)
          .map((endpoint) => `${endpoint.method} ${endpoint.path}`),
      }));
    const report = evaluateBadges(specs, results);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    // Docs-sample evidence caps support at docs-only.
    for (const verdict of report.verdicts) {
      expect(verdict.supported).toBe('docs-only');
    }
  }, 120_000);
});
