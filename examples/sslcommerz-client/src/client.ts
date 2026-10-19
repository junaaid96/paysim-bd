// Sample merchant app: an Express shop integrated against the simulator the
// same way it would integrate against the real SSLCommerz sandbox — init,
// redirect, IPN listener, callbacks, and server-side validation. Its IPN
// signature check is an independent port of the official PHP lib's
// SSLCOMMERZ_hash_verify (deliberately NOT imported from the simulator).

import { createHash } from 'node:crypto';

import express, { type Application, type Request, type Response } from 'express';

export interface ClientOptions {
  simBaseUrl: string;
  clientBaseUrl: string;
  storeId?: string;
  storePasswd?: string;
}

export interface JournalEntry {
  tranId: string;
  sessionkey?: string;
  gatewayPageUrl?: string;
  initAt?: string;
  ipn?: { status: string; valId: string; signatureOk: boolean; validated?: string };
  callbacks: Array<{ kind: string; at: string; payload: Record<string, string> }>;
  validations: Array<{ status: string; at: string; via: string }>;
}

function md5Hex(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex');
}

function computeVerifySign(
  payload: Record<string, string>,
  verifyKey: string,
  storePasswd: string,
): string {
  const data: Record<string, string> = {};
  for (const key of verifyKey.split(',')) {
    const value = payload[key];
    if (value !== undefined) data[key] = value;
  }
  data['store_passwd'] = md5Hex(storePasswd);
  const hashString = Object.keys(data)
    .sort()
    .map((key) => `${key}=${data[key]}`)
    .join('&');
  return md5Hex(hashString);
}

function formToRecord(body: unknown): Record<string, string> {
  if (body === null || typeof body !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
    else if (Array.isArray(value) && typeof value[0] === 'string') out[key] = value[0];
  }
  return out;
}

function page(title: string, body: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<title>${title}</title></head>` +
    '<body style="font-family:system-ui,sans-serif;max-width:640px;margin:24px auto;padding:0 16px">' +
    `<h1>${title}</h1>${body}</body></html>`
  );
}

export function createClientApp(options: ClientOptions): {
  app: Application;
  journal: Map<string, JournalEntry>;
} {
  const storeId = options.storeId ?? 'testbox';
  const storePasswd = options.storePasswd ?? 'qwerty';
  const journal = new Map<string, JournalEntry>();
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  async function validate(valId: string): Promise<string> {
    const params = new URLSearchParams({
      val_id: valId,
      store_id: storeId,
      store_passwd: storePasswd,
      v: '1',
      format: 'json',
    });
    const res = await fetch(
      `${options.simBaseUrl}/validator/api/validationserverAPI.php?${params.toString()}`,
    );
    const data = (await res.json()) as { status?: unknown };
    return typeof data.status === 'string' ? data.status : 'UNKNOWN';
  }

  app.get('/', (_req: Request, res: Response) => {
    const rows = [...journal.values()]
      .map(
        (entry) =>
          `<li><a href="/pay/status/${entry.tranId}">${entry.tranId}</a> — ` +
          `ipn: ${entry.ipn?.status ?? 'none'}, callbacks: ${entry.callbacks.length}</li>`,
      )
      .join('');
    res.send(
      page(
        'Example Shop (sample client)',
        '<p>Demo product: Widget — <strong>150.75 BDT</strong></p>' +
          '<form method="POST" action="/pay/initiate"><button type="submit">Pay with SSLCommerz (simulated)</button></form>' +
          `<h2>Journal</h2><ul>${rows || '<li>empty</li>'}</ul>`,
      ),
    );
  });

  app.post('/pay/initiate', async (req: Request, res: Response) => {
    const tranId = `EXAMPLE-${Date.now()}`;
    // Optional SIM: magic scenario marker, e.g. /pay/initiate?value_d=SIM:duplicate-ipn.
    const valueD = req.query['value_d'];
    const params = new URLSearchParams({
      store_id: storeId,
      store_passwd: storePasswd,
      total_amount: '150.75',
      currency: 'BDT',
      tran_id: tranId,
      product_category: 'demo',
      success_url: `${options.clientBaseUrl}/pay/success`,
      fail_url: `${options.clientBaseUrl}/pay/fail`,
      cancel_url: `${options.clientBaseUrl}/pay/cancel`,
      ipn_url: `${options.clientBaseUrl}/pay/ipn`,
      value_a: 'example-ref',
      ...(typeof valueD === 'string' && valueD ? { value_d: valueD } : {}),
    });
    const initRes = await fetch(`${options.simBaseUrl}/gwprocess/v4/api.php`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const init = (await initRes.json()) as {
      status?: string;
      GatewayPageURL?: string;
      sessionkey?: string;
      failedreason?: string;
    };
    if (init.status !== 'SUCCESS' || !init.GatewayPageURL || !init.sessionkey) {
      res.status(502).send(page('Init failed', `<p>${init.failedreason ?? 'unknown'}</p>`));
      return;
    }
    journal.set(tranId, {
      tranId,
      sessionkey: init.sessionkey,
      gatewayPageUrl: init.GatewayPageURL,
      initAt: new Date().toISOString(),
      callbacks: [],
      validations: [],
    });
    res.redirect(302, init.GatewayPageURL);
  });

  app.post('/pay/ipn', async (req: Request, res: Response) => {
    const payload = formToRecord(req.body);
    const tranId = payload['tran_id'] ?? '';
    const entry = journal.get(tranId);
    if (!entry) {
      res.status(200).send('Unknown tran_id');
      return;
    }
    const verifyKey = payload['verify_key'];
    const verifySign = payload['verify_sign'];
    const signatureOk =
      verifyKey !== undefined &&
      verifySign !== undefined &&
      computeVerifySign(payload, verifyKey, storePasswd) === verifySign;
    entry.ipn = {
      status: payload['status'] ?? '',
      valId: payload['val_id'] ?? '',
      signatureOk,
    };
    if (entry.ipn.status === 'VALID' && signatureOk && entry.ipn.valId) {
      const status = await validate(entry.ipn.valId);
      entry.ipn.validated = status;
      entry.validations.push({ status, at: new Date().toISOString(), via: 'ipn' });
    }
    res.status(200).send('IPN received');
  });

  async function handleCallback(kind: 'success' | 'fail' | 'cancel', req: Request, res: Response) {
    const payload = formToRecord(req.body);
    const tranId = payload['tran_id'] ?? '';
    const entry = journal.get(tranId);
    if (entry) {
      entry.callbacks.push({ kind, at: new Date().toISOString(), payload });
      if (kind === 'success' && entry.ipn?.valId) {
        const status = await validate(entry.ipn.valId);
        entry.validations.push({ status, at: new Date().toISOString(), via: 'callback' });
      }
    }
    const heading =
      kind === 'success'
        ? 'Payment successful'
        : kind === 'fail'
          ? 'Payment failed'
          : 'Payment cancelled';
    res
      .status(200)
      .send(
        page(
          heading,
          `<p>Order <code>${tranId}</code></p>` +
            `<p>Amount: ${payload['amount'] ?? ''} ${payload['currency'] ?? ''}</p>` +
            `<p><a href="/">Back to shop</a></p>`,
        ),
      );
  }

  app.post('/pay/success', (req: Request, res: Response) => {
    void handleCallback('success', req, res);
  });
  app.post('/pay/fail', (req: Request, res: Response) => {
    void handleCallback('fail', req, res);
  });
  app.post('/pay/cancel', (req: Request, res: Response) => {
    void handleCallback('cancel', req, res);
  });

  app.get('/pay/status/:tranId', (req: Request, res: Response) => {
    const tranIdParam = req.params['tranId'];
    const entry = journal.get(typeof tranIdParam === 'string' ? tranIdParam : '');
    if (!entry) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(entry);
  });

  return { app, journal };
}
