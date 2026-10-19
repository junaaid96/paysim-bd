import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { isDisallowedIp, safePost } from '../src/ssrf.js';

describe('isDisallowedIp', () => {
  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.5',
    '172.16.4.9',
    '172.31.255.1',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    '0:0:0:0:0:0:0:1',
    '0:0:0:0:0:0:0:0',
    'fe80::1',
    'FE80::ABCD',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.1.2.3',
    '::ffff:7f00:1',
    'fe80::1%eth0',
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isDisallowedIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '192.167.1.1', '203.0.113.7'])(
    'allows public IPv4 %s',
    (ip) => {
      expect(isDisallowedIp(ip)).toBe(false);
    },
  );

  it.each(['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8'])(
    'allows public IPv6 %s',
    (ip) => {
      expect(isDisallowedIp(ip)).toBe(false);
    },
  );
});

describe('safePost', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function listen(
    handler: (url: string) => { status: number; body: string },
  ): Promise<string> {
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const { status, body } = handler(req.url ?? '/');
        res.writeHead(status, { 'content-type': 'text/plain' });
        res.end(body);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}`;
  }

  it('refuses literal private IPs when private targets are disallowed', async () => {
    const result = await safePost(
      { url: 'http://127.0.0.1:9/ipn', body: 'a=b' },
      { allowPrivate: false },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe(true);
      expect(result.error).toMatch(/private IP/);
    }
  });

  it('resolves hostnames and refuses private resolutions', async () => {
    // localhost resolves locally with no network access.
    const result = await safePost(
      { url: 'http://localhost:9/ipn', body: 'a=b' },
      { allowPrivate: false },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe(true);
      expect(result.error).toMatch(/private IP/);
    }
  });

  it('rejects non-http(s) schemes without retrying', async () => {
    const result = await safePost({ url: 'file:///etc/passwd', body: '' }, { allowPrivate: false });
    expect(result).toMatchObject({ ok: false, blocked: true });
  });

  it('treats DNS failures as transient (retryable)', async () => {
    const result = await safePost(
      // .invalid never resolves (RFC 2606); deterministic offline.
      { url: 'http://paysim-no-such-host.invalid/ipn', body: 'a=b' },
      { allowPrivate: false, timeoutMs: 2_000 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe(false);
      expect(result.error).toMatch(/DNS lookup failed/);
    }
  });

  it('POSTs to private targets when explicitly allowed', async () => {
    let seen = '';
    const base = await listen((url) => {
      seen = url;
      return { status: 200, body: 'ok' };
    });
    const result = await safePost({ url: `${base}/ipn`, body: 'a=b' }, { allowPrivate: true });
    expect(result).toMatchObject({ ok: true, status: 200, body: 'ok' });
    expect(seen).toBe('/ipn');
  });

  it('follows redirects and re-checks each hop', async () => {
    const base = await listen((url) => ({ status: 200, body: `got:${url}` }));
    const redirecting = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.url === '/hop') {
          res.writeHead(302, { location: `${base}/final` });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('direct');
      });
    });
    servers.push(redirecting);
    await new Promise<void>((resolve) => redirecting.listen(0, '127.0.0.1', () => resolve()));
    const port = (redirecting.address() as AddressInfo).port;

    const result = await safePost(
      { url: `http://127.0.0.1:${port}/hop`, body: 'a=b' },
      { allowPrivate: true },
    );
    expect(result).toMatchObject({ ok: true, status: 200, body: 'got:/final' });
  });

  it('stops redirect loops without retrying', async () => {
    const looping = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(302, { location: '/loop' });
        res.end();
      });
    });
    servers.push(looping);
    await new Promise<void>((resolve) => looping.listen(0, '127.0.0.1', () => resolve()));
    const port = (looping.address() as AddressInfo).port;

    const result = await safePost(
      { url: `http://127.0.0.1:${port}/loop`, body: 'a=b' },
      { allowPrivate: true, maxRedirects: 2 },
    );
    expect(result).toMatchObject({ ok: false, blocked: true });
    if (!result.ok) expect(result.error).toMatch(/too many redirects/);
  });

  it('caps response bodies', async () => {
    const base = await listen(() => ({ status: 200, body: 'x'.repeat(1000) }));
    const result = await safePost(
      { url: `${base}/big`, body: 'a=b' },
      { allowPrivate: true, maxBodyBytes: 100 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toHaveLength(100);
      expect(result.truncated).toBe(true);
    }
  });
});
