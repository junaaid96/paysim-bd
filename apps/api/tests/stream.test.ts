import { get, type ClientRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { EventBus } from '../src/events/bus.js';
import { createStreamRouter } from '../src/routes/stream.js';
import type { Queries } from '../src/stores/drizzle-stores.js';

describe('SSE stream', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
  });

  it('emits hello then live bus messages', async () => {
    const bus = new EventBus();
    const queries = {
      getWorkspaceByKey: async (key: string) =>
        key === 'local-default' ? { id: 'ws-1', key, name: 'Local' } : null,
    } as unknown as Queries;
    const app = express();
    app.use('/api', createStreamRouter({ bus, queries }));
    const server = app.listen(0, '127.0.0.1');
    cleanups.push(() => server.close());
    await new Promise<void>((resolve) => server.on('listening', () => resolve()));
    const port = (server.address() as AddressInfo).port;

    const chunks: string[] = [];
    const req: ClientRequest = get(
      `http://127.0.0.1:${port}/api/stream?workspace=local-default`,
      (res) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('text/event-stream');
        res.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
      },
    );
    cleanups.push(() => req.destroy());
    await new Promise((resolve) => setTimeout(resolve, 300));
    bus.publish({ type: 'txn.created', workspaceKey: 'local-default', data: { id: 't1' } });
    bus.publish({ type: 'txn.created', workspaceKey: 'other', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const text = chunks.join('');
    expect(text).toContain('event: connected');
    expect(text).toContain('event: txn.created');
    expect(text).toContain('"id":"t1"');
    expect(bus.subscriberCount('local-default')).toBe(1);
    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(bus.subscriberCount('local-default')).toBe(0);
  });

  it('connects a brand-new workspace that has no row yet', async () => {
    const bus = new EventBus();
    const queries = { getWorkspaceByKey: async () => null } as unknown as Queries;
    const app = express();
    app.use('/api', createStreamRouter({ bus, queries }));
    const server = app.listen(0, '127.0.0.1');
    cleanups.push(() => server.close());
    await new Promise<void>((resolve) => server.on('listening', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const chunks: string[] = [];
    let status = 0;
    const req: ClientRequest = get(
      `http://127.0.0.1:${port}/api/stream?workspace=brand-new-ws`,
      (res) => {
        status = res.statusCode ?? 0;
        res.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
      },
    );
    cleanups.push(() => req.destroy());
    await new Promise((resolve) => setTimeout(resolve, 300));
    bus.publish({ type: 'txn.created', workspaceKey: 'brand-new-ws', data: { id: 'n1' } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(status).toBe(200);
    const text = chunks.join('');
    expect(text).toContain('event: connected');
    expect(text).toContain('"id":"n1"');
  });

  it('rejects a malformed workspace key', async () => {
    const bus = new EventBus();
    const queries = { getWorkspaceByKey: async () => null } as unknown as Queries;
    const app = express();
    app.use('/api', createStreamRouter({ bus, queries }));
    const server = app.listen(0, '127.0.0.1');
    cleanups.push(() => server.close());
    await new Promise<void>((resolve) => server.on('listening', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve) => {
      const req = get(
        `http://127.0.0.1:${port}/api/stream?workspace=${encodeURIComponent('../x y')}`,
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
        },
      );
      cleanups.push(() => req.destroy());
    });
    expect(status).toBe(400);
  });
});
