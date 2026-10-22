// Optional real-sandbox mode for bKash tokenized checkout. Merchants keep
// calling PaySim with their PaySim credentials; PaySim calls the bKash
// tokenized sandbox (grant/create/execute/status/refund) with the app's
// own sandbox keys. Provider id_tokens are cached in kv_entries so every
// serverless instance reuses one token until shortly before it expires.

import { z } from 'zod';

import { refundLedger } from '@paysim/core';
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

import { formatAmountMinor } from './builders.js';
import { createMemoryKv } from './tokens.js';
import { asString } from './util.js';

export const BKASH_SANDBOX_BASE = 'https://tokenized.sandbox.bka.sh/v1.2.0-beta/tokenized/checkout';
const TIMEOUT_MS = 20_000;
const TOKEN_NAMESPACE = 'bkash-real-token';
/** bKash id_tokens live 3600s; refresh a few minutes early. */
const TOKEN_TTL_MS = 55 * 60 * 1000;

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
/** Test hook: swap the HTTP client (mocked provider responses). */
export function setBkashFetch(next: Fetch | null): void {
  fetchImpl = next ?? ((...args) => fetch(...args));
}

const fallbackKv = createMemoryKv();

export interface BkashKeys {
  username: string;
  password: string;
  appKey: string;
  appSecret: string;
}

const KeysSchema = z
  .object({
    username: z.string().trim().min(1).max(128),
    password: z.string().trim().min(1).max(256),
    app_key: z.string().trim().min(1).max(256),
    app_secret: z.string().trim().min(1).max(512),
  })
  .strict();

export function realKeys(app: AppRecord | null): BkashKeys | null {
  const keys = app?.sandbox?.mode === 'real' ? app.sandbox.keys : null;
  if (!keys?.['username'] || !keys['password'] || !keys['app_key'] || !keys['app_secret']) {
    return null;
  }
  return {
    username: keys['username'],
    password: keys['password'],
    appKey: keys['app_key'],
    appSecret: keys['app_secret'],
  };
}

async function post(
  path: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(`${BKASH_SANDBOX_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new Error(`bKash sandbox answered HTTP ${res.status} with a non-JSON body`);
}

export class BkashSandboxError extends Error {
  constructor(
    public readonly statusCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'BkashSandboxError';
  }
}

function tokenKey(app: AppRecord, keys: BkashKeys): string {
  return `${app.id}:${keys.appKey}`;
}

export async function providerToken(
  kv: KeyValueStore | undefined,
  app: AppRecord,
  keys: BkashKeys,
  force = false,
): Promise<string> {
  const store = kv ?? fallbackKv;
  const key = tokenKey(app, keys);
  if (!force) {
    const hit = await store.get(TOKEN_NAMESPACE, key);
    if (hit && typeof hit['idToken'] === 'string') return hit['idToken'];
  }
  const body = await post(
    '/token/grant',
    { username: keys.username, password: keys.password },
    { app_key: keys.appKey, app_secret: keys.appSecret },
  );
  const idToken = asString(body['id_token']);
  if (asString(body['statusCode']) !== '0000' || !idToken) {
    throw new BkashSandboxError(
      asString(body['statusCode'], '9999'),
      `bKash sandbox grant failed: ${asString(body['statusMessage'] ?? body['msg'], 'unknown error')}`,
    );
  }
  await store.set(TOKEN_NAMESPACE, key, { idToken }, new Date(Date.now() + TOKEN_TTL_MS));
  return idToken;
}

/** Authorized call; one retry with a fresh token if the cached one was rejected. */
export async function callProvider(
  kv: KeyValueStore | undefined,
  app: AppRecord,
  keys: BkashKeys,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let token = await providerToken(kv, app, keys);
  let out = await post(path, { authorization: token, 'x-app-key': keys.appKey }, body);
  const msg = asString(out['message'] ?? out['statusMessage']).toLowerCase();
  if (msg.includes('unauthorized') || msg.includes('token')) {
    token = await providerToken(kv, app, keys, true);
    out = await post(path, { authorization: token, 'x-app-key': keys.appKey }, body);
  }
  return out;
}

export function providerOk(body: Record<string, unknown>): boolean {
  return asString(body['statusCode']) === '0000';
}

export function providerMessage(body: Record<string, unknown>): string {
  return asString(
    body['statusMessage'] ?? body['errorMessage'] ?? body['message'],
    'Process failed',
  );
}

export async function settleRealRefund(
  ctx: Pick<PluginContext, 'stores' | 'logger' | 'clock'>,
  txn: TxnRecord,
  app: AppRecord,
  input: SettleRefundInput,
): Promise<SettleRefundResult> {
  const keys = realKeys(app);
  const trxId = asString(txn.metadata['trxId']);
  if (!keys || txn.metadata['sandboxMode'] !== 'real' || !trxId) {
    return { ok: false, failureReason: 'Payment was not made through the real sandbox.' };
  }
  // The public tokenized sandbox (v1.2 refund API) allows ONE refund per
  // payment (full or partial); a second call just returns the first refund.
  const prior = refundLedger(txn).refunds.find((entry) => entry.status === 'completed');
  if (prior) {
    return {
      ok: false,
      failureReason:
        'bKash sandbox allows one refund per payment (full or partial); this payment was already refunded.',
    };
  }
  try {
    const body = await callProvider(ctx.stores.kv, app, keys, '/payment/refund', {
      paymentID: txn.gatewaySessionKey ?? '',
      amount: formatAmountMinor(input.amountMinor),
      trxID: trxId,
      sku: 'paysim',
      reason: (input.reason || 'Refund').replace(/[<>&]/g, ' ').slice(0, 255),
    });
    const refundTrxId = asString(body['refundTrxID']);
    const known = refundLedger(txn).refunds.some((entry) => entry.providerRefundId === refundTrxId);
    const ok = asString(body['transactionStatus']) === 'Completed' && !!refundTrxId && !known;
    await ctx.stores.recordEvent({
      workspaceId: txn.workspaceId,
      transactionId: txn.id,
      type: 'bkash.sandbox.refund',
      data: {
        statusCode: asString(body['statusCode']),
        statusMessage: providerMessage(body),
        transactionStatus: asString(body['transactionStatus']),
        refundTrxID: asString(body['refundTrxID']),
      },
    });
    return ok
      ? { ok: true, providerRefundId: asString(body['refundTrxID']) }
      : { ok: false, failureReason: `bKash sandbox: ${providerMessage(body)}` };
  } catch (err) {
    return {
      ok: false,
      failureReason: `bKash sandbox unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export const bkashSandbox: SandboxSupport = {
  status: 'available',
  note: 'Uses the bKash tokenized checkout sandbox. bKash publishes shared sandbox keys and test wallets; merchants can also use the keys from their own bKash onboarding.',
  docsUrl: 'https://developer.bka.sh/docs/tokenized-checkout-process-overview',
  fields: [
    { name: 'username', label: 'Username', secret: false },
    { name: 'password', label: 'Password', secret: true },
    { name: 'app_key', label: 'App key', secret: false },
    { name: 'app_secret', label: 'App secret', secret: true },
  ],
  publicTestKeys: {
    username: 'sandboxTokenizedUser02',
    password: 'sandboxTokenizedUser02@12345',
    app_key: '4f6o0cjiki2rfm34kfdadl1eqq',
    app_secret: '2is7hdktrekvrbljjh44ll3d9l1dtjo4pasmjvs5vl5qr3fug4b',
  },
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
  settleRefund: settleRealRefund,
};
