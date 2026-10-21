// Sealed live-query endpoint: returns a bearer sealed query when Realtime is
// configured, 501 when it is not (dashboard falls back to REST+SSE).
import { randomBytes } from 'node:crypto';

import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createLiveRouter } from '../src/routes/live.js';
import type { Queries } from '../src/stores/drizzle-stores.js';
import { makeEnv } from './helpers.js';

// Well-formed dummy secret (prefix + 32 base64url bytes). Sealing is local
// crypto, so no network or real credential is needed.
const dummySecret = `nrt_live_1${randomBytes(32).toString('base64url')}`;

describe('live routes', () => {
  const queries = {
    getWorkspaceByKey: async (key: string) =>
      key === 'local-default' ? { id: 'ws-1', key, name: 'Local' } : null,
  } as unknown as Queries;

  let sealed: express.Application;
  let unsealed: express.Application;
  let malformed: express.Application;

  function mount(secret: string | undefined): express.Application {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/live',
      createLiveRouter({ env: makeEnv({ NEON_REALTIME_SECRET: secret }), queries }),
    );
    return app;
  }

  beforeEach(() => {
    sealed = mount(dummySecret);
    unsealed = mount(undefined);
    malformed = mount('test-secret');
  });

  it('seals the activity query for a known workspace', async () => {
    const res = await request(sealed)
      .post('/api/live/activity')
      .send({ workspaceKey: 'local-default' });
    expect(res.status).toBe(200);
    const body = res.body as { sealed: Record<string, unknown> };
    expect(typeof body.sealed['capability']).toBe('string');
    expect(typeof body.sealed['queryFingerprint']).toBe('string');
    expect(body.sealed['expiresAt']).toEqual(expect.any(Number));
    expect(body.sealed['expiresAt'] as number).toBeGreaterThan(Date.now());
  });

  it('answers 501 when Realtime is not configured', async () => {
    const res = await request(unsealed)
      .post('/api/live/activity')
      .send({ workspaceKey: 'local-default' });
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({ error: 'realtime_not_configured' });
  });

  it('answers 501 for a malformed secret instead of crashing', async () => {
    const res = await request(malformed)
      .post('/api/live/activity')
      .send({ workspaceKey: 'local-default' });
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({ error: 'realtime_not_configured' });
  });

  it('answers 404 for an unknown workspace', async () => {
    const res = await request(sealed).post('/api/live/activity').send({ workspaceKey: 'nope' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'unknown_workspace' });
  });
});
