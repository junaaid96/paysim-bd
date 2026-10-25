// Optional real-sandbox mode for Upay (UCB Fintech). Active only when a
// store saves its Upay merchant credentials; otherwise the simulator runs.
//
// Endpoint sources (Upay's official PGW API v4.1.0 PDF is not public; these
// paths come from community integrations that cite it, so treat as
// unverified until checked against Upay's merchant docs):
//   - https://bdpaygate.github.io/docs/upay
//   - https://github.com/byteminus/laravel-bdpaygate (src/Drivers/UpayGateway.php,
//     tests/Conformance/UpayScenario.php)
// Calls (every path ends in "/"):
//   POST /payment/merchant-auth/            {merchant_id, merchant_key} -> data.token (MAS2001)
//   POST /payment/merchant-payment-init/    Authorization: UPAY <token> -> data.gateway_url (MPIS2002)
//   GET  /payment/single-payment-status/{txn_id}/                       -> data.status (PS2005)
//   POST /payment/bulk/refund/              [{txn_id, refund_amount}]   -> data.success_list (MPR_200)
// UAT host https://uat-pg.upay.systems (reachable; answers DVE4001 to bad
// bodies). Live host https://pg.upaysystem.com is per BDPayGate only, and
// live access needs Upay to allow-list the server IP.

import { z } from 'zod';

import type {
  AppRecord,
  CredentialCheck,
  KeyValueStore,
  PluginContext,
  SandboxSupport,
  SettleRefundInput,
  SettleRefundResult,
  TxnRecord,
} from '@paysim/core';

import { dhakaDate, formatAmountMinor } from './builders.js';
import { asString } from './util.js';

export const UPAY_UAT_BASE = 'https://uat-pg.upay.systems';
const TIMEOUT_MS = 20_000;
const TOKEN_NAMESPACE = 'upay-real-token';
/** BDPayGate caches the merchant-auth token ~10 minutes. */
const TOKEN_TTL_MS = 9 * 60 * 1000;

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
/** Test hook: swap the HTTP client (mocked provider responses). */
export function setUpayFetch(next: Fetch | null): void {
  fetchImpl = next ?? ((...args) => fetch(...args));
}

const memory = new Map<string, { value: Record<string, unknown>; exp: number }>();
const fallbackKv: KeyValueStore = {
  async get(ns, key) {
    const hit = memory.get(`${ns}:${key}`);
    return hit && hit.exp > Date.now() ? hit.value : null;
  },
  async set(ns, key, value, expiresAt) {
    memory.set(`${ns}:${key}`, { value, exp: expiresAt.getTime() });
  },
  async delete(ns, key) {
    memory.delete(`${ns}:${key}`);
  },
};

const KeysSchema = z.object({
  merchant_id: z.string().trim().min(1).max(64),
  merchant_key: z.string().trim().min(1).max(512),
  merchant_code: z.string().trim().min(1).max(64),
  merchant_name: z.string().trim().min(1).max(128),
  merchant_mobile: z
    .string()
    .trim()
    .regex(/^01\d{9}$/, 'must be an 11-digit 01… number'),
  merchant_category_code: z.string().trim().min(1).max(16),
  merchant_city: z.string().trim().max(64).optional().default(''),
  base_url: z
    .string()
    .trim()
    .max(200)
    .optional()
    .default('')
    .refine((v) => v === '' || /^https:\/\/[^\s/]+$/.test(v), 'must be https://host (no path)'),
});
export type UpayKeys = z.output<typeof KeysSchema>;

export function realKeys(app: AppRecord | null): UpayKeys | null {
  const keys = app?.sandbox?.mode === 'real' ? app.sandbox.keys : null;
  if (!keys) return null;
  const parsed = KeysSchema.safeParse(keys);
  return parsed.success ? parsed.data : null;
}

function baseOf(keys: Pick<UpayKeys, 'base_url'>): string {
  return keys.base_url || UPAY_UAT_BASE;
}

export class UpayProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 0,
  ) {
    super(message);
    this.name = 'UpayProviderError';
  }
}

async function call(
  url: string,
  init: { method: 'GET' | 'POST'; body?: unknown; token?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.token) headers['authorization'] = `UPAY ${init.token}`;
  const res = await fetchImpl(url, {
    method: init.method,
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = { message: text.slice(0, 200) };
  }
  return { status: res.status, body };
}

function message(body: Record<string, unknown>, status: number): string {
  const msg = asString(body['message']) || `HTTP ${status}`;
  const code = asString(body['code']);
  return code ? `${msg} (${code})` : msg;
}

function dataOf(body: Record<string, unknown>): Record<string, unknown> {
  const d = body['data'];
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
}

export async function merchantAuth(
  keys: Pick<UpayKeys, 'merchant_id' | 'merchant_key' | 'base_url'>,
): Promise<string> {
  const { status, body } = await call(`${baseOf(keys)}/payment/merchant-auth/`, {
    method: 'POST',
    body: { merchant_id: keys.merchant_id, merchant_key: keys.merchant_key },
  });
  const token = asString(dataOf(body)['token']);
  if (status >= 400 || !token) {
    throw new UpayProviderError(
      asString(body['code']),
      `merchant-auth failed: ${message(body, status)}`,
      status,
    );
  }
  return token;
}

async function token(
  kv: KeyValueStore | undefined,
  app: AppRecord,
  keys: UpayKeys,
  force = false,
): Promise<string> {
  const store = kv ?? fallbackKv;
  const key = `${app.id}:${keys.merchant_id}`;
  if (!force) {
    const hit = await store.get(TOKEN_NAMESPACE, key);
    if (hit && typeof hit['token'] === 'string') return hit['token'];
  }
  const fresh = await merchantAuth(keys);
  await store.set(TOKEN_NAMESPACE, key, { token: fresh }, new Date(Date.now() + TOKEN_TTL_MS));
  return fresh;
}

/** Authorized call; on 401/403 retry once with a fresh token (BDPayGate behaviour). */
async function authed(
  kv: KeyValueStore | undefined,
  app: AppRecord,
  keys: UpayKeys,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<{ status: number; body: Record<string, unknown> }> {
  let res = await call(`${baseOf(keys)}${path}`, { ...init, token: await token(kv, app, keys) });
  if (res.status === 401 || res.status === 403) {
    res = await call(`${baseOf(keys)}${path}`, {
      ...init,
      token: await token(kv, app, keys, true),
    });
  }
  return res;
}

/** Provider txn_id: unique per PaySim transaction, alphanumeric. */
export function providerTxnId(txn: TxnRecord): string {
  return `PS${txn.id.replace(/[^A-Za-z0-9]/g, '')}`.slice(0, 32);
}

export async function realInit(
  ctx: Pick<PluginContext, 'stores' | 'simBaseUrl'>,
  app: AppRecord,
  keys: UpayKeys,
  txn: TxnRecord,
): Promise<
  | { ok: true; gatewayUrl: string; txnId: string; trxId: string; sessionId: string }
  | { ok: false; reason: string }
> {
  const txnId = providerTxnId(txn);
  try {
    const { status, body } = await authed(
      ctx.stores.kv,
      app,
      keys,
      '/payment/merchant-payment-init/',
      {
        method: 'POST',
        body: {
          date: dhakaDate(),
          txn_id: txnId,
          invoice_id: txnId,
          amount: formatAmountMinor(txn.amountMinor),
          transaction_currency_code: 'BDT',
          redirect_url: `${ctx.simBaseUrl}/upay/sandbox/callback/${txn.id}`,
          merchant_id: keys.merchant_id,
          merchant_name: keys.merchant_name,
          merchant_code: keys.merchant_code,
          merchant_country_code: 'BD',
          merchant_city: keys.merchant_city || 'Dhaka',
          merchant_category_code: keys.merchant_category_code,
          merchant_mobile: keys.merchant_mobile,
          additional_info: { reference: asString(txn.metadata['invoiceId']) },
        },
      },
    );
    const data = dataOf(body);
    const gatewayUrl = asString(data['gateway_url']);
    if (status >= 400 || !/^https:\/\//.test(gatewayUrl)) {
      return { ok: false, reason: message(body, status) };
    }
    return {
      ok: true,
      gatewayUrl,
      txnId,
      trxId: asString(data['trx_id']),
      sessionId: asString(data['session_id']),
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export interface RealStatus {
  status: string;
  amount: string;
  trxId: string;
  wallet: string;
}

/** single-payment-status; null = no answer yet (404 PNF4012 / error envelope). */
export async function realStatus(
  ctx: Pick<PluginContext, 'stores'>,
  app: AppRecord,
  keys: UpayKeys,
  txnId: string,
): Promise<RealStatus | null> {
  const { status, body } = await authed(
    ctx.stores.kv,
    app,
    keys,
    `/payment/single-payment-status/${encodeURIComponent(txnId)}/`,
    { method: 'GET' },
  );
  const data = dataOf(body);
  if (status >= 400 || typeof data['status'] !== 'string') return null;
  if (asString(data['txn_id']) && asString(data['txn_id']) !== txnId) {
    throw new UpayProviderError('', 'single-payment-status returned a different txn_id');
  }
  return {
    status: asString(data['status']).toLowerCase(),
    amount:
      typeof data['amount'] === 'number' ? data['amount'].toFixed(2) : asString(data['amount']),
    trxId: asString(data['trx_id']),
    wallet: asString(data['customer_wallet']),
  };
}

export async function settleRealRefund(
  ctx: Pick<PluginContext, 'stores' | 'logger' | 'clock'>,
  txn: TxnRecord,
  app: AppRecord,
  input: SettleRefundInput,
): Promise<SettleRefundResult> {
  const keys = realKeys(app);
  const txnId = asString(txn.metadata['providerTxnId']);
  if (!keys || txn.metadata['sandboxMode'] !== 'real' || !txnId) {
    return { ok: false, failureReason: 'Payment was not made through the real Upay sandbox.' };
  }
  try {
    const { status, body } = await authed(ctx.stores.kv, app, keys, '/payment/bulk/refund/', {
      method: 'POST',
      // NOTE: BDPayGate only sends full refunds; partial refund_amount is unconfirmed.
      body: [{ txn_id: txnId, refund_amount: formatAmountMinor(input.amountMinor) }],
    });
    const data = dataOf(body);
    const ok =
      Array.isArray(data['success_list']) && data['success_list'].map(String).includes(txnId);
    if (ok) return { ok: true, providerRefundId: txnId };
    const failed = data['failed_list'];
    const entry =
      failed && typeof failed === 'object' ? (failed as Record<string, unknown>)[txnId] : undefined;
    const en =
      entry && typeof entry === 'object' ? asString((entry as Record<string, unknown>)['en']) : '';
    // "Your request is under process" = accepted, settles later (BDPayGate).
    if (/under process/i.test(en)) return { ok: true, providerRefundId: `${txnId}:pending` };
    return { ok: false, failureReason: `Upay: ${en || message(body, status)}` };
  } catch (err) {
    return {
      ok: false,
      failureReason: `Upay: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export const upaySandbox: SandboxSupport = {
  status: 'available',
  note: 'Needs merchant credentials from Upay (UCB Fintech): merchant ID + key, merchant code, name, mobile and category code. Endpoints follow community docs citing Upay PGW API v4.1.0 (unverified). Without saved keys Upay stays on the simulator.',
  docsUrl: 'https://bdpaygate.github.io/docs/upay',
  signupUrl: 'https://www.upaybd.com/',
  fields: [
    { name: 'merchant_id', label: 'Merchant ID', secret: false },
    { name: 'merchant_key', label: 'Merchant key', secret: true },
    { name: 'merchant_code', label: 'Merchant code', secret: false },
    { name: 'merchant_name', label: 'Merchant name', secret: false },
    { name: 'merchant_mobile', label: 'Merchant mobile (01…)', secret: false },
    { name: 'merchant_category_code', label: 'Merchant category code (MCC)', secret: false },
    { name: 'merchant_city', label: 'Merchant city (optional, default Dhaka)', secret: false },
    { name: 'base_url', label: `Base URL (optional, default ${UPAY_UAT_BASE})`, secret: false },
  ],
  validateKeys(input: unknown): CredentialCheck {
    const parsed = KeysSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      };
    }
    return { ok: true, value: { ...parsed.data } };
  },
  async testConnection(_ctx, _app, keys) {
    const checked = upaySandbox.validateKeys(keys);
    if (!checked.ok) return { ok: false, message: checked.issues.join('; '), offline: true };
    const k = checked.value as UpayKeys;
    try {
      await merchantAuth(k);
      return { ok: true, message: `Upay merchant-auth accepted these credentials (${baseOf(k)}).` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },
  settleRefund: settleRealRefund,
};
