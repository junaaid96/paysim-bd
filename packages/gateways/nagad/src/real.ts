// Optional real-sandbox mode for Nagad. Activates when an app saves its
// Nagad merchant ID, merchant private key and Nagad public key. Merchants
// keep calling PaySim with their PaySim (fixture-sealed) requests; PaySim
// re-seals each step for the Nagad sandbox with the saved keys:
//   initialize  POST /check-out/initialize/{merchantId}/{orderId}
//   complete    POST /check-out/complete/{paymentReferenceId}
//   verify      GET  /verify/payment/{paymentReferenceId}
//   refund      POST /purchase/cancel?paymentRefId=..  (community-documented)
// sensitiveData = base64 RSA-PKCS1v1.5(Nagad public key, JSON); signature =
// base64 SHA256withRSA(merchant private key, same JSON). Responses are
// decrypted with the merchant private key and verified with the Nagad key.

import { createPrivateKey, randomBytes } from 'node:crypto';

import { z } from 'zod';

import { refundLedger } from '@paysim/core';
import type {
  AppRecord,
  CredentialCheck,
  PluginContext,
  SandboxSupport,
  SettleRefundInput,
  SettleRefundResult,
  TxnRecord,
} from '@paysim/core';

import { formatAmountMinor } from './builders.js';
import {
  isParsableRsaPublicKey,
  normalizePrivateKeyPem,
  rsaDecrypt,
  rsaEncrypt,
  rsaSign,
  rsaVerify,
} from './crypto.js';
import { asString } from './util.js';

export const NAGAD_SANDBOX_BASE =
  'http://sandbox.mynagad.com:10080/remote-payment-gateway-1.0/api/dfs';
const TIMEOUT_MS = 20_000;

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
/** Test hook: swap the HTTP client (mocked provider responses). */
export function setNagadFetch(next: Fetch | null): void {
  fetchImpl = next ?? ((...args) => fetch(...args));
}

export interface NagadKeys {
  merchantId: string;
  merchantPrivatePem: string;
  nagadPublicKey: string;
}

function loadPrivatePem(input: string): string | null {
  for (const pem of [
    input.trim(),
    normalizePrivateKeyPem(input, true),
    normalizePrivateKeyPem(input, false),
  ]) {
    try {
      const key = createPrivateKey(pem);
      if (key.asymmetricKeyType === 'rsa') return pem;
    } catch {
      // try next encoding
    }
  }
  return null;
}

const KeysSchema = z
  .object({
    merchant_id: z.string().trim().min(1).max(64),
    merchant_private_key: z.string().trim().min(100).max(8192),
    nagad_public_key: z.string().trim().min(100).max(4096),
  })
  .strict();

export function realKeys(app: AppRecord | null): NagadKeys | null {
  const keys = app?.sandbox?.mode === 'real' ? app.sandbox.keys : null;
  if (!keys?.['merchant_id'] || !keys['merchant_private_key'] || !keys['nagad_public_key']) {
    return null;
  }
  const pem = loadPrivatePem(keys['merchant_private_key']);
  if (!pem) return null;
  return {
    merchantId: keys['merchant_id'],
    merchantPrivatePem: pem,
    nagadPublicKey: keys['nagad_public_key'],
  };
}

/** Nagad datetime: yyyyMMddHHmmss in Asia/Dhaka (UTC+6). */
export function nagadDateTime(now = new Date()): string {
  const d = new Date(now.getTime() + 6 * 3_600_000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json',
  'X-KM-Api-Version': 'v-0.2.0',
  'X-KM-IP-V4': '127.0.0.1',
  'X-KM-Client-Type': 'PC_WEB',
};

async function call(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    ...init,
    headers: HEADERS,
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
  throw new Error(`Nagad sandbox answered HTTP ${res.status} with a non-JSON body`);
}

export function seal(keys: NagadKeys, payload: Record<string, unknown>): Record<string, string> {
  const plaintext = JSON.stringify(payload);
  return {
    sensitiveData: rsaEncrypt(keys.nagadPublicKey, plaintext),
    signature: rsaSign(keys.merchantPrivatePem, plaintext),
  };
}

export function open(keys: NagadKeys, body: Record<string, unknown>): Record<string, unknown> {
  const plaintext = rsaDecrypt(keys.merchantPrivatePem, asString(body['sensitiveData']));
  if (!rsaVerify(keys.nagadPublicKey, plaintext, asString(body['signature']))) {
    throw new Error('Nagad sandbox response signature did not verify with the Nagad public key');
  }
  return JSON.parse(plaintext) as Record<string, unknown>;
}

function providerMessage(body: Record<string, unknown>): string {
  return asString(body['message'] ?? body['reason'] ?? body['status'], 'request failed');
}

/** Provider orderId: unique per PaySim txn, alphanumeric (Nagad rejects symbols). */
export function providerOrderId(txn: TxnRecord): string {
  return `PS${txn.id.replace(/-/g, '').slice(0, 18)}`;
}

export async function realInitialize(
  keys: NagadKeys,
  txn: TxnRecord,
): Promise<
  { ok: true; ref: string; challenge: string; dateTime: string } | { ok: false; reason: string }
> {
  const orderId = providerOrderId(txn);
  const dateTime = nagadDateTime();
  const challenge = randomBytes(20).toString('hex');
  try {
    const body = await call(
      `${NAGAD_SANDBOX_BASE}/check-out/initialize/${encodeURIComponent(keys.merchantId)}/${orderId}?locale=EN`,
      {
        method: 'POST',
        body: JSON.stringify({
          dateTime,
          ...seal(keys, { merchantId: keys.merchantId, datetime: dateTime, orderId, challenge }),
        }),
      },
    );
    if (!body['sensitiveData']) return { ok: false, reason: providerMessage(body) };
    const opened = open(keys, body);
    const ref = asString(opened['paymentReferenceId']);
    const providerChallenge = asString(opened['challenge']);
    if (!ref || !providerChallenge)
      return { ok: false, reason: 'initialize response missing reference' };
    return { ok: true, ref, challenge: providerChallenge, dateTime };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function realComplete(
  keys: NagadKeys,
  txn: TxnRecord,
  amountMinor: number,
  callbackUrl: string,
): Promise<{ ok: true; callBackUrl: string } | { ok: false; reason: string }> {
  try {
    const body = await call(
      `${NAGAD_SANDBOX_BASE}/check-out/complete/${encodeURIComponent(asString(txn.metadata['providerRef']))}`,
      {
        method: 'POST',
        body: JSON.stringify({
          ...seal(keys, {
            merchantId: keys.merchantId,
            orderId: asString(txn.metadata['providerOrderId']),
            currencyCode: '050',
            amount: formatAmountMinor(amountMinor),
            challenge: asString(txn.metadata['providerChallenge']),
          }),
          merchantCallbackURL: callbackUrl,
          additionalMerchantInfo: { paysimTxn: txn.id },
        }),
      },
    );
    const url = asString(body['callBackUrl']);
    if (asString(body['status']) === 'Success' && /^https?:\/\//.test(url)) {
      return { ok: true, callBackUrl: url };
    }
    return { ok: false, reason: providerMessage(body) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export interface NagadVerification {
  status: string;
  amountMinor: number | null;
  issuerPaymentRefNo: string;
  raw: Record<string, unknown>;
}

export async function realVerify(providerRef: string): Promise<NagadVerification> {
  const body = await call(
    `${NAGAD_SANDBOX_BASE}/verify/payment/${encodeURIComponent(providerRef)}`,
    {
      method: 'GET',
    },
  );
  const amount = Number(asString(body['amount'], 'NaN'));
  return {
    status: asString(body['status']),
    amountMinor: Number.isFinite(amount) ? Math.round(amount * 100) : null,
    issuerPaymentRefNo: asString(body['issuerPaymentRefNo'] ?? body['issuerPaymentReferenceNo']),
    raw: {
      status: asString(body['status']),
      statusCode: asString(body['statusCode']),
      amount: asString(body['amount']),
      orderId: asString(body['orderId']),
      issuerPaymentRefNo: asString(body['issuerPaymentRefNo']),
    },
  };
}

export async function settleRealRefund(
  ctx: Pick<PluginContext, 'stores' | 'logger' | 'clock'>,
  txn: TxnRecord,
  app: AppRecord,
  input: SettleRefundInput,
): Promise<SettleRefundResult> {
  const keys = realKeys(app);
  const ref = asString(txn.metadata['providerRef']);
  if (!keys || txn.metadata['sandboxMode'] !== 'real' || !ref) {
    return { ok: false, failureReason: 'Payment was not made through the real sandbox.' };
  }
  try {
    const body = await call(
      `${NAGAD_SANDBOX_BASE}/purchase/cancel?paymentRefId=${encodeURIComponent(ref)}`,
      {
        method: 'POST',
        body: JSON.stringify(
          seal(keys, {
            merchantId: keys.merchantId,
            originalRequestDate: asString(txn.metadata['providerDateTime']).slice(0, 8),
            originalAmount: formatAmountMinor(txn.amountMinor),
            cancelAmount: formatAmountMinor(input.amountMinor),
            referenceNo: input.refundId,
            referenceMessage: (input.reason || 'Refund').slice(0, 100),
          }),
        ),
      },
    );
    let result: Record<string, unknown> = body;
    if (body['sensitiveData']) result = open(keys, body);
    const status = asString(result['status']);
    const ok = status === 'Success';
    await ctx.stores.recordEvent({
      workspaceId: txn.workspaceId,
      transactionId: txn.id,
      type: 'nagad.sandbox.refund',
      data: {
        status,
        message: asString(result['message']),
        cancelTrxId: asString(result['cancelTrxId']),
      },
    });
    return ok
      ? { ok: true, providerRefundId: asString(result['cancelTrxId'] ?? result['refundTrxId']) }
      : { ok: false, failureReason: `Nagad sandbox: ${providerMessage(result)}` };
  } catch (err) {
    return {
      ok: false,
      failureReason: `Nagad sandbox: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export const nagadSandbox: SandboxSupport = {
  status: 'available',
  note: 'Needs credentials Nagad issues to registered merchants: merchant ID, your merchant private key and the Nagad sandbox public key. Without them Nagad stays on the simulator.',
  docsUrl: 'https://nagad.com.bd/',
  fields: [
    { name: 'merchant_id', label: 'Merchant ID', secret: false },
    { name: 'merchant_private_key', label: 'Merchant private key (PEM or base64)', secret: true },
    { name: 'nagad_public_key', label: 'Nagad public key (PEM or base64)', secret: true },
  ],
  signupUrl: 'https://nagad.com.bd/',
  async testConnection(_ctx, _app, keys) {
    // Nagad's sandbox only answers merchant servers Nagad has allow-listed,
    // so this is an offline check: the keys load and can seal a request.
    const checked = nagadSandbox.validateKeys(keys);
    if (!checked.ok) return { ok: false, message: checked.issues.join('; '), offline: true };
    try {
      const pem = loadPrivatePem(keys['merchant_private_key'] ?? '');
      if (!pem) throw new Error('merchant_private_key: not a loadable RSA private key');
      seal(
        {
          merchantId: keys['merchant_id'] ?? '',
          merchantPrivatePem: pem,
          nagadPublicKey: keys['nagad_public_key'] ?? '',
        },
        { probe: 'paysim' },
      );
      return {
        ok: true,
        offline: true,
        message:
          'Keys load and sign correctly (checked offline; Nagad only answers allow-listed merchant servers).',
      };
    } catch (err) {
      return {
        ok: false,
        offline: true,
        message: err instanceof Error ? err.message : String(err),
      };
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
    if (!loadPrivatePem(parsed.data.merchant_private_key)) {
      return { ok: false, issues: ['merchant_private_key: not a loadable RSA private key'] };
    }
    if (!isParsableRsaPublicKey(parsed.data.nagad_public_key)) {
      return { ok: false, issues: ['nagad_public_key: not a loadable RSA public key'] };
    }
    return { ok: true, value: { ...parsed.data } };
  },
  settleRefund: settleRealRefund,
};

/** Already refunded at the provider? (keeps the ledger honest on retries) */
export function hasProviderRefund(txn: TxnRecord, id: string): boolean {
  return refundLedger(txn).refunds.some((entry) => entry.providerRefundId === id);
}
