// Optional real-sandbox mode: PaySim proxies to sandbox.sslcommerz.com
// with the store's own sandbox keys, while merchants keep calling the
// PaySim endpoints with their PaySim store_id/store_passwd. The provider
// returns the customer (and its IPN) to PaySim, PaySim validates the
// payment with the provider's validation API, records it, and forwards
// PaySim-shaped callbacks/IPNs to the merchant as in simulator mode.

import { z } from 'zod';

import type {
  AppRecord,
  CredentialCheck,
  PluginContext,
  SandboxSupport,
  SettleRefundInput,
  SettleRefundResult,
  TxnRecord,
} from '@paysim/core';

import { formatAmount, type CardFixture } from './builders.js';
import { asString } from './util.js';

export const SSLCZ_SANDBOX_HOST = 'https://sandbox.sslcommerz.com';
const TIMEOUT_MS = 15_000;

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
/** Test hook: swap the HTTP client (mocked provider responses). */
export function setSslczFetch(next: Fetch | null): void {
  fetchImpl = next ?? ((...args) => fetch(...args));
}

const KeysSchema = z
  .object({
    store_id: z.string().trim().min(1).max(64),
    store_passwd: z.string().trim().min(1).max(256),
  })
  .strict();

export function realKeys(app: AppRecord | null): { storeId: string; storePasswd: string } | null {
  const keys = app?.sandbox?.mode === 'real' ? app.sandbox.keys : null;
  if (!keys?.['store_id'] || !keys['store_passwd']) return null;
  return { storeId: keys['store_id'], storePasswd: keys['store_passwd'] };
}

async function call(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new Error(`SSLCommerz sandbox answered HTTP ${res.status} with a non-JSON body`);
}

/** Provider tran_id: unique per PaySim txn (shared sandbox stores are global). */
export function providerTranId(txn: TxnRecord): string {
  return `PS${txn.id.replace(/-/g, '').slice(0, 26)}`;
}

const REQUIRED_DEFAULTS: Record<string, string> = {
  cus_name: 'PaySim Test Customer',
  cus_email: 'customer@example.com',
  cus_add1: 'Test address',
  cus_city: 'Test city',
  cus_postcode: '1000',
  cus_country: 'Bangladesh',
  cus_phone: '01700000000',
  shipping_method: 'NO',
  product_name: 'PaySim order',
  product_profile: 'general',
  num_of_item: '1',
};

export interface RealInitResult {
  ok: boolean;
  gatewayPageUrl?: string;
  sessionkey?: string;
  failedreason?: string;
}

export async function initRealSession(
  ctx: PluginContext,
  txn: TxnRecord,
  keys: { storeId: string; storePasswd: string },
  merchantFields: Record<string, unknown>,
): Promise<RealInitResult> {
  const base = `${ctx.simBaseUrl}/gwprocess/sandbox`;
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(merchantFields)) {
    if (typeof value === 'string' || typeof value === 'number') form.set(key, String(value));
  }
  for (const [key, value] of Object.entries(REQUIRED_DEFAULTS)) {
    if (!form.get(key)) form.set(key, value);
  }
  form.set('store_id', keys.storeId);
  form.set('store_passwd', keys.storePasswd);
  form.set('total_amount', formatAmount(txn.amountMinor));
  form.set('currency', txn.currency);
  form.set('tran_id', providerTranId(txn));
  form.set('success_url', `${base}/return/${txn.id}/success`);
  form.set('fail_url', `${base}/return/${txn.id}/fail`);
  form.set('cancel_url', `${base}/return/${txn.id}/cancel`);
  form.set('ipn_url', `${base}/ipn/${txn.id}`);
  try {
    const body = await call(`${SSLCZ_SANDBOX_HOST}/gwprocess/v4/api.php`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const url = asString(body['GatewayPageURL']);
    if (body['status'] === 'SUCCESS' && /^https:\/\//.test(url)) {
      return { ok: true, gatewayPageUrl: url, sessionkey: asString(body['sessionkey']) };
    }
    return { ok: false, failedreason: asString(body['failedreason'], 'Sandbox init failed') };
  } catch (err) {
    return { ok: false, failedreason: err instanceof Error ? err.message : String(err) };
  }
}

export interface ProviderValidation {
  ok: boolean;
  status: string;
  valId: string;
  bankTranId: string;
  tranDate: string;
  card: CardFixture;
  reason?: string;
}

/** Validation API: the only trusted source for a provider success. */
export async function validateWithProvider(
  txn: TxnRecord,
  keys: { storeId: string; storePasswd: string },
  valId: string,
): Promise<ProviderValidation> {
  const params = new URLSearchParams({
    val_id: valId,
    store_id: keys.storeId,
    store_passwd: keys.storePasswd,
    format: 'json',
  });
  const empty: CardFixture = {
    cardType: '',
    cardNo: '',
    cardIssuer: '',
    cardBrand: '',
    cardIssuerCountry: '',
    cardIssuerCountryCode: '',
  };
  try {
    const body = await call(
      `${SSLCZ_SANDBOX_HOST}/validator/api/validationserverAPI.php?${params.toString()}`,
    );
    const status = asString(body['status']);
    const amountOk = Math.round(Number(body['amount']) * 100) === txn.amountMinor;
    const tranOk = asString(body['tran_id']) === providerTranId(txn);
    const ok = (status === 'VALID' || status === 'VALIDATED') && amountOk && tranOk;
    return {
      ok,
      status,
      valId,
      bankTranId: asString(body['bank_tran_id']),
      tranDate: asString(body['tran_date']),
      card: {
        cardType: asString(body['card_type']),
        cardNo: asString(body['card_no']),
        cardIssuer: asString(body['card_issuer']),
        cardBrand: asString(body['card_brand']),
        cardIssuerCountry: asString(body['card_issuer_country']),
        cardIssuerCountryCode: asString(body['card_issuer_country_code']),
      },
      ...(ok
        ? {}
        : {
            reason: !tranOk
              ? 'tran_id mismatch'
              : !amountOk
                ? 'amount mismatch'
                : `status ${status || 'unknown'}`,
          }),
    };
  } catch (err) {
    return {
      ok: false,
      status: 'ERROR',
      valId,
      bankTranId: '',
      tranDate: '',
      card: empty,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function settleRealRefund(
  ctx: Pick<PluginContext, 'stores' | 'logger' | 'clock'>,
  txn: TxnRecord,
  app: AppRecord,
  input: SettleRefundInput,
): Promise<SettleRefundResult> {
  const keys = realKeys(app);
  const bankTranId = asString(txn.metadata['bankTranId']);
  if (!keys || txn.metadata['sandboxMode'] !== 'real' || !bankTranId) {
    return { ok: false, failureReason: 'Payment was not made through the real sandbox.' };
  }
  const params = new URLSearchParams({
    bank_tran_id: bankTranId,
    refund_trans_id: input.refundId,
    refund_amount: formatAmount(input.amountMinor),
    refund_remarks: input.reason || 'Refund',
    store_id: keys.storeId,
    store_passwd: keys.storePasswd,
    format: 'json',
  });
  try {
    const body = await call(
      `${SSLCZ_SANDBOX_HOST}/validator/api/merchantTransIDvalidationAPI.php?${params.toString()}`,
    );
    const status = asString(body['status']).toLowerCase();
    const ok = body['APIConnect'] === 'DONE' && (status === 'success' || status === 'processing');
    await ctx.stores.recordEvent({
      workspaceId: txn.workspaceId,
      transactionId: txn.id,
      type: 'sslcommerz.sandbox.refund',
      data: {
        APIConnect: asString(body['APIConnect']),
        status,
        refund_ref_id: asString(body['refund_ref_id']),
        errorReason: asString(body['errorReason']),
      },
    });
    return ok
      ? { ok: true, providerRefundId: asString(body['refund_ref_id']) }
      : {
          ok: false,
          failureReason: `SSLCommerz sandbox: ${asString(body['errorReason']) || status || 'refund declined'}`,
        };
  } catch (err) {
    return {
      ok: false,
      failureReason: `SSLCommerz sandbox unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export const sslcommerzSandbox: SandboxSupport = {
  status: 'available',
  note: 'Uses your SSLCommerz sandbox store (free signup at developer.sslcommerz.com). Payments open the real SSLCommerz sandbox page.',
  docsUrl: 'https://developer.sslcommerz.com/doc/v4/',
  fields: [
    { name: 'store_id', label: 'Sandbox Store ID', secret: false },
    { name: 'store_passwd', label: 'Sandbox Store Password', secret: true },
  ],
  publicTestKeys: { store_id: 'testbox', store_passwd: 'qwerty' },
  signupUrl: 'https://developer.sslcommerz.com/registration/',
  async testConnection(_ctx, _app, keys) {
    // Transaction query by an unknown tran_id: creates nothing, but the
    // provider only answers APIConnect=DONE for valid store credentials.
    const params = new URLSearchParams({
      tran_id: `PAYSIM-CHECK-${Date.now()}`,
      store_id: keys['store_id'] ?? '',
      store_passwd: keys['store_passwd'] ?? '',
      format: 'json',
    });
    try {
      const body = await call(
        `${SSLCZ_SANDBOX_HOST}/validator/api/merchantTransIDvalidationAPI.php?${params.toString()}`,
      );
      const connect = asString(body['APIConnect']);
      if (connect === 'DONE')
        return { ok: true, message: 'SSLCommerz sandbox accepted the store credentials.' };
      return {
        ok: false,
        message: `SSLCommerz sandbox rejected the store credentials (${connect || 'no APIConnect'}).`,
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
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
