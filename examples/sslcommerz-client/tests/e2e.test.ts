// Phase 1 acceptance: a real sample Express client on localhost completes
// init -> redirect -> checkout -> IPN -> validation against a real booted
// API (separate process, real HTTP), and the dashboard API shows it live.
// Needs TEST_DATABASE_URL (a scratch server; the suite creates paysim_e2e).

import { spawn, type ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createClientApp } from '../src/client.js';

const TEST_URL = process.env['TEST_DATABASE_URL'];
const maybe = TEST_URL ? describe : describe.skip;

// Fixed ports for the spawned API (documented; override-free and CI-safe).
const API_PORT = 3211;
const API_BASE = `http://127.0.0.1:${API_PORT}`;

interface JournalIpn {
  status: string;
  valId: string;
  signatureOk: boolean;
  validated?: string;
}

interface JournalEntry {
  tranId: string;
  ipn?: JournalIpn;
  callbacks: Array<{ kind: string }>;
  validations: Array<{ status: string; via: string }>;
}

maybe('sslcommerz end-to-end', () => {
  let apiChild: ChildProcess | null = null;
  let apiLog = '';
  let clientBaseUrl = '';
  let closeClient: (() => Promise<void>) | null = null;
  // NOTE: tests run in file order; later tests reuse these tran_ids.
  const successTranId: string[] = [];

  async function waitForReady(url: string, timeoutMs: number): Promise<void> {
    const started = Date.now();
    for (;;) {
      try {
        const res = await fetch(url);
        if (res.ok) return;
      } catch {
        // Retry until the budget is spent.
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for ${url}\n${apiLog.slice(-3000)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  function parseForm(html: string): { action: string; fields: Record<string, string> } {
    const action = html.match(/<form[^>]*action="([^"]+)"/)?.[1];
    if (!action) throw new Error('No form action in response HTML');
    const fields: Record<string, string> = {};
    for (const match of html.matchAll(/name="([^"]+)" value="([^"]*)"/g)) {
      fields[match[1]] = match[2];
    }
    return { action, fields };
  }

  beforeAll(async () => {
    const e2eUrl = new URL(TEST_URL as string);
    e2eUrl.pathname = '/paysim_e2e';
    const admin = postgres(TEST_URL as string, { max: 1 });
    try {
      await admin.unsafe('CREATE DATABASE paysim_e2e');
    } catch (err) {
      if (!/already exists/.test(err instanceof Error ? err.message : String(err))) throw err;
    } finally {
      await admin.end();
    }

    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const tsxBin = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
    apiChild = spawn(tsxBin, ['src/index.ts'], {
      cwd: `${repoRoot}/apps/api`,
      env: {
        ...process.env,
        DATABASE_URL: e2eUrl.toString(),
        PORT: String(API_PORT),
        SIM_BASE_URL: API_BASE,
        LOG_LEVEL: 'warn',
        ALLOW_PRIVATE_CALLBACK_TARGETS: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    apiChild.stdout?.on('data', (chunk: Buffer) => {
      apiLog += chunk.toString('utf8');
    });
    apiChild.stderr?.on('data', (chunk: Buffer) => {
      apiLog += chunk.toString('utf8');
    });
    await waitForReady(`${API_BASE}/api/ready`, 90_000);

    const opts = { simBaseUrl: API_BASE, clientBaseUrl: '' };
    const { app } = createClientApp(opts);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.on('listening', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    opts.clientBaseUrl = `http://127.0.0.1:${port}`;
    clientBaseUrl = opts.clientBaseUrl;
    closeClient = () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
  }, 150_000);

  afterAll(async () => {
    await closeClient?.();
    if (apiChild) {
      apiChild.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (apiChild.exitCode === null) apiChild.kill('SIGKILL');
    }
  });

  it('completes init -> redirect -> IPN -> validation', async () => {
    const initiated = await fetch(`${clientBaseUrl}/pay/initiate`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(initiated.status).toBe(302);
    const gatewayPageUrl = initiated.headers.get('location') ?? '';
    expect(gatewayPageUrl).toContain(`${API_BASE}/gwprocess/v4/gw.php?Q=PAY&SESSIONKEY=`);
    const sessionkey = new URL(gatewayPageUrl).searchParams.get('SESSIONKEY') ?? '';

    const page = await fetch(gatewayPageUrl);
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain('PaySim sandbox — test only, no real money');
    const tranId = pageHtml.match(/EXAMPLE-\d+/)?.[0] ?? '';
    expect(tranId).not.toBe('');
    successTranId.push(tranId);

    const done = await fetch(`${API_BASE}/gwprocess/v4/gw.php?SESSIONKEY=${sessionkey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'success' }).toString(),
    });
    expect(done.status).toBe(200);
    const form = parseForm(await done.text());
    expect(form.action).toBe(`${clientBaseUrl}/pay/success`);
    expect(form.fields['tran_id']).toBe(tranId);

    // The simulator awaits IPN delivery before responding, so it is
    // already in the journal here — no sleeps, no polling.
    const journal = (await (
      await fetch(`${clientBaseUrl}/pay/status/${tranId}`)
    ).json()) as JournalEntry;
    expect(journal.ipn?.status).toBe('VALID');
    expect(journal.ipn?.signatureOk).toBe(true);
    expect(journal.ipn?.validated).toBe('VALID');

    const receipt = await fetch(form.action, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form.fields).toString(),
    });
    expect(receipt.status).toBe(200);
    expect(await receipt.text()).toContain(tranId);

    const valRes = await fetch(
      `${API_BASE}/validator/api/validationserverAPI.php?val_id=${journal.ipn?.valId}&store_id=testbox&store_passwd=qwerty&format=json`,
    );
    expect(((await valRes.json()) as { status: string }).status).toBe('VALIDATED');
  }, 60_000);

  it('drives a failed payment end to end', async () => {
    const initiated = await fetch(`${clientBaseUrl}/pay/initiate`, {
      method: 'POST',
      redirect: 'manual',
    });
    const gatewayPageUrl = initiated.headers.get('location') ?? '';
    const sessionkey = new URL(gatewayPageUrl).searchParams.get('SESSIONKEY') ?? '';
    const pageHtml = await (await fetch(gatewayPageUrl)).text();
    const tranId = pageHtml.match(/EXAMPLE-\d+/)?.[0] ?? '';

    const done = await fetch(`${API_BASE}/gwprocess/v4/gw.php?SESSIONKEY=${sessionkey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'fail' }).toString(),
    });
    const form = parseForm(await done.text());
    expect(form.action).toBe(`${clientBaseUrl}/pay/fail`);

    const journal = (await (
      await fetch(`${clientBaseUrl}/pay/status/${tranId}`)
    ).json()) as JournalEntry;
    expect(journal.ipn?.status).toBe('FAILED');
    expect(journal.ipn?.signatureOk).toBe(true);
    expect(journal.ipn?.validated).toBeUndefined();

    await fetch(form.action, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form.fields).toString(),
    });
    const after = (await (
      await fetch(`${clientBaseUrl}/pay/status/${tranId}`)
    ).json()) as JournalEntry;
    expect(after.callbacks.map((callback) => callback.kind)).toEqual(['fail']);

    const valRes = await fetch(
      `${API_BASE}/validator/api/validationserverAPI.php?val_id=&store_id=testbox&store_passwd=qwerty&format=json`,
    );
    expect(((await valRes.json()) as { status: string }).status).toBe('INVALID_TRANSACTION');
  }, 60_000);

  it('drives duplicate-ipn with zero browser clicks via a SIM: marker', async () => {
    const initiated = await fetch(
      `${clientBaseUrl}/pay/initiate?value_d=${encodeURIComponent('SIM:duplicate-ipn')}`,
      { method: 'POST', redirect: 'manual' },
    );
    expect(initiated.status).toBe(302);
    const gatewayPageUrl = initiated.headers.get('location') ?? '';
    expect(gatewayPageUrl).toContain('/gwprocess/v4/gw.php?Q=PAY&SESSIONKEY=');
    // Read the tran_id off the mock page; no buttons are clicked.
    const pageHtml = await (await fetch(gatewayPageUrl)).text();
    const tranId = pageHtml.match(/EXAMPLE-\d+/)?.[0] ?? '';
    expect(tranId).not.toBe('');

    let journal: JournalEntry | null = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const status = await fetch(`${clientBaseUrl}/pay/status/${tranId}`);
      if (status.ok) {
        const entry = (await status.json()) as JournalEntry;
        if (entry.ipn) {
          journal = entry;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(journal?.ipn?.status).toBe('VALID');
    expect(journal?.ipn?.signatureOk).toBe(true);

    // The duplicate lands ~1s later; poll the dashboard API for it.
    let deliveries: Array<{ kind: string; status: string }> = [];
    let types: string[] = [];
    let attachedSource: string | null = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const txns = (await (
        await fetch(`${API_BASE}/api/txns?workspace=local-default`)
      ).json()) as Array<{ id: string; gatewayTxnId: string }>;
      const found = txns.find((txn) => txn.gatewayTxnId === tranId);
      if (found) {
        const detail = (await (await fetch(`${API_BASE}/api/txns/${found.id}`)).json()) as {
          events: Array<{ type: string; data: Record<string, unknown> }>;
          deliveries: Array<{ kind: string; status: string }>;
        };
        deliveries = detail.deliveries;
        types = detail.events.map((event) => event.type);
        attachedSource =
          (detail.events.find((event) => event.type === 'scenario.attached')?.data[
            'source'
          ] as string) ?? null;
        if (deliveries.length === 2 && types.includes('scenario.ended')) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(attachedSource).toBe('magic');
    expect(types).toContain('scenario.ended');
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((delivery) => delivery.status === 'delivered')).toBe(true);
  }, 60_000);

  it('shows the transaction in the dashboard API with timeline and delivery', async () => {
    const txns = (await (
      await fetch(`${API_BASE}/api/txns?workspace=local-default`)
    ).json()) as Array<{ id: string; gatewayTxnId: string; state: string }>;
    const found = txns.find((txn) => txn.gatewayTxnId === successTranId[0]);
    expect(found?.state).toBe('valid');

    const detail = (await (await fetch(`${API_BASE}/api/txns/${found?.id}`)).json()) as {
      events: Array<{ type: string }>;
      deliveries: Array<{ kind: string; status: string }>;
    };
    const types = detail.events.map((event) => event.type);
    expect(types).toContain('sslcommerz.init.received');
    expect(types).toContain('sslcommerz.checkout.success');
    expect(types).toContain('sslcommerz.validation.checked');
    expect(detail.deliveries).toHaveLength(1);
    expect(detail.deliveries[0]).toMatchObject({ kind: 'ipn', status: 'delivered' });
  }, 30_000);
});
