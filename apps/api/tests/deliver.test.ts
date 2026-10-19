import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  DeliveryRecord,
  PluginLogger,
  PluginStores,
  RecordDeliveryInput,
  RecordEventInput,
} from '@paysim/core';

import {
  backoffForAttempt,
  deliverCallbackNow,
  runScheduledRetry,
  shouldRetryAfterAttempt,
  type DeliverDeps,
  type ScheduleRetryJob,
} from '../src/deliver.js';

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('delivery retry policy', () => {
  it('backs off exponentially and stops after the max attempts', () => {
    expect(backoffForAttempt(2)).toBe(2_000);
    expect(backoffForAttempt(3)).toBe(4_000);
    expect(backoffForAttempt(6)).toBe(32_000);
    expect(backoffForAttempt(99)).toBe(300_000);
    expect(shouldRetryAfterAttempt(1)).toBe(true);
    expect(shouldRetryAfterAttempt(5)).toBe(true);
    expect(shouldRetryAfterAttempt(6)).toBe(false);
  });
});

describe('deliverCallbackNow', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  function stubStores(captured: RecordDeliveryInput[], events: RecordEventInput[]): PluginStores {
    return {
      recordDelivery: async (input: RecordDeliveryInput) => {
        captured.push(input);
        return { id: `dlv-${captured.length}`, ...input } as unknown as DeliveryRecord;
      },
      recordEvent: async (input: RecordEventInput) => {
        events.push(input);
        return { id: `evt-${events.length}`, ...input } as never;
      },
    } as unknown as PluginStores;
  }

  function makeDeps(captured: RecordDeliveryInput[], events: RecordEventInput[]) {
    const retries: ScheduleRetryJob[] = [];
    const deps: DeliverDeps = {
      stores: stubStores(captured, events),
      logger: silentLogger,
      allowPrivate: true,
      scheduleRetry: async (job: ScheduleRetryJob) => {
        retries.push(job);
      },
    };
    return { deps, retries };
  }

  async function listen(
    handler: (body: string, contentType: string | undefined) => { status: number; body: string },
  ): Promise<string> {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        const contentType = req.headers['content-type'];
        const { status, body: responseBody } = handler(
          body,
          Array.isArray(contentType) ? contentType.join(',') : contentType,
        );
        res.writeHead(status, { 'content-type': 'text/plain' });
        res.end(responseBody);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}/ipn`;
  }

  const txn = { id: 'txn-1', workspaceId: 'ws-1' } as never;

  it('POSTs form-encoded payloads and records delivered on 2xx', async () => {
    let seenBody = '';
    let seenContentType: string | undefined;
    const target = await listen((body, contentType) => {
      seenBody = body;
      seenContentType = contentType;
      return { status: 200, body: 'Payment Record Updated Successfully' };
    });
    const captured: RecordDeliveryInput[] = [];
    const events: RecordEventInput[] = [];
    const { deps, retries } = makeDeps(captured, events);
    const record = await deliverCallbackNow(deps, {
      txn,
      kind: 'ipn',
      targetUrl: target,
      payload: { tran_id: 'A B', status: 'VALID' },
    });
    expect(record.status).toBe('delivered');
    expect(typeof record.latencyMs).toBe('number');
    expect(seenBody).toBe('tran_id=A+B&status=VALID');
    expect(seenContentType).toBe('application/x-www-form-urlencoded');
    expect(captured[0]?.responseStatus).toBe(200);
    expect(captured[0]?.responseSnippet).toContain('Payment Record Updated');
    expect(retries).toHaveLength(0);
  });

  it('records failed on non-2xx and schedules a retry', async () => {
    const target = await listen(() => ({ status: 500, body: 'boom' }));
    const captured: RecordDeliveryInput[] = [];
    const events: RecordEventInput[] = [];
    const { deps, retries } = makeDeps(captured, events);
    const record = await deliverCallbackNow(deps, {
      txn,
      kind: 'ipn',
      targetUrl: target,
      payload: { a: 'b' },
    });
    expect(record.status).toBe('failed');
    expect(captured[0]?.responseStatus).toBe(500);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ attempt: 2, kind: 'ipn', targetUrl: target });
    expect(retries[0]?.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('records failed on connection refused', async () => {
    const captured: RecordDeliveryInput[] = [];
    const events: RecordEventInput[] = [];
    const { deps, retries } = makeDeps(captured, events);
    const record = await deliverCallbackNow(deps, {
      txn,
      kind: 'ipn',
      targetUrl: 'http://127.0.0.1:1/nope',
      payload: { a: 'b' },
    });
    expect(record.status).toBe('failed');
    expect(captured[0]?.responseSnippet ?? '').toMatch(/delivery error:/);
    expect(retries).toHaveLength(1);
  });

  it('records failed on timeout', async () => {
    const hanging = createServer(() => undefined);
    servers.push(hanging);
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', () => resolve()));
    const address = hanging.address() as AddressInfo;
    const captured: RecordDeliveryInput[] = [];
    const events: RecordEventInput[] = [];
    const { deps } = makeDeps(captured, events);
    const record = await deliverCallbackNow(
      { ...deps, timeoutMs: 100 },
      {
        txn,
        kind: 'ipn',
        targetUrl: `http://127.0.0.1:${address.port}/ipn`,
        payload: { a: 'b' },
      },
    );
    expect(record.status).toBe('failed');
  });

  it('blocks private targets without retrying when allowPrivate is false', async () => {
    const target = await listen(() => ({ status: 200, body: 'unreachable' }));
    const captured: RecordDeliveryInput[] = [];
    const events: RecordEventInput[] = [];
    const { deps, retries } = makeDeps(captured, events);
    const record = await deliverCallbackNow(
      { ...deps, allowPrivate: false },
      { txn, kind: 'ipn', targetUrl: target, payload: { a: 'b' } },
    );
    expect(record.status).toBe('blocked');
    expect(captured[0]?.responseSnippet ?? '').toMatch(/blocked:/);
    expect(retries).toHaveLength(0);
    expect(events.map((event) => event.type)).toContain('callback.blocked');
  });

  it('gives up after the last attempt with a callback.dead event', async () => {
    const target = await listen(() => ({ status: 500, body: 'still down' }));
    const captured: RecordDeliveryInput[] = [];
    const events: RecordEventInput[] = [];
    const { deps, retries } = makeDeps(captured, events);
    const record = await runScheduledRetry(deps, {
      txn,
      kind: 'ipn',
      targetUrl: target,
      payload: { a: 'b' },
      attempt: 6,
    });
    expect(record.status).toBe('failed');
    expect(retries).toHaveLength(0);
    expect(events.map((event) => event.type)).toContain('callback.dead');
  });
});
