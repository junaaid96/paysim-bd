// Response builders + generated identifiers. Shapes follow the doc
// samples (spec/v1.json); anything the docs leave open is called out.

import { randomBytes } from 'node:crypto';

/** Real codes from payment-error-codes.md (mappings chosen in routes). */
export const BKASH_ERRORS = {
  INVALID_APP_KEY: { externalCode: '2001', errorMessageEn: 'Invalid App Key' },
  INVALID_PAYMENT_ID: { externalCode: '2002', errorMessageEn: 'Invalid Payment ID' },
  PROCESS_FAILED: { externalCode: '2003', errorMessageEn: 'Process failed' },
  INVALID_AMOUNT: { externalCode: '2006', errorMessageEn: 'Invalid amount' },
  INVALID_CURRENCY: { externalCode: '2007', errorMessageEn: 'Invalid currency.' },
  INVALID_INTENT: { externalCode: '2008', errorMessageEn: 'Invalid intent' },
  INVALID_BODY: { externalCode: '2025', errorMessageEn: 'Invalid request body' },
  INVALID_INVOICE: { externalCode: '2031', errorMessageEn: 'Invalid merchant invoice number' },
  INVALID_PAYER_REFERENCE: { externalCode: '2048', errorMessageEn: 'Invalid Payer Reference' },
  INVALID_CALLBACK_URL: { externalCode: '2049', errorMessageEn: 'Invalid Merchant Callback URL' },
  INVALID_PAYMENT_STATE: { externalCode: '2056', errorMessageEn: 'Invalid Payment State' },
  PREREQUISITE_NOT_MET: {
    externalCode: '2060',
    errorMessageEn: "Payment execution pre-requisite hasn't been met",
  },
  ALREADY_COMPLETED: {
    externalCode: '2062',
    errorMessageEn: 'The payment has already been completed',
  },
  MISSING_FIELD: { externalCode: '2065', errorMessageEn: 'Mendatory field missing' },
} as const;

/** Sample-verified internalCodes; omitted for every other error. */
export const INTERNAL_CODES = {
  INVALID_CURRENCY: 'invalid_currency',
  INVALID_PAYMENT_ID: 'invalid_payment_id',
  ALREADY_COMPLETED: 'payment_already_completed',
} as const;

export interface PaymentErrorInput {
  externalCode: string;
  errorMessageEn: string;
  internalCode?: string;
}

export function buildPaymentError(input: PaymentErrorInput): Record<string, unknown> {
  return {
    ...(input.internalCode ? { internalCode: input.internalCode } : {}),
    externalCode: input.externalCode,
    errorMessageEn: input.errorMessageEn,
    errorMessageBn: null,
  };
}

export function buildGrantError(statusCode: string, statusMessage: string): Record<string, string> {
  return { statusCode, statusMessage };
}

export function buildGrantResponse(input: {
  idToken: string;
  refreshToken: string;
  expiresIn: number;
}): Record<string, unknown> {
  // expires_in: the doc table says string but the sample shows a number.
  return {
    statusCode: '0000',
    statusMessage: 'Successful',
    token_type: 'Bearer',
    id_token: input.idToken,
    refresh_token: input.refreshToken,
    expires_in: input.expiresIn,
  };
}

/** Sample shape: TR + 4 digits + 7 alnum + epoch millis. */
export function generatePaymentId(nowMs: number): string {
  return `TR0011${randomAlnum(7)}${nowMs}`;
}

/** Sample shape: 9 chars of A-Z0-9. */
export function generateTrxId(): string {
  return randomFrom('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 9);
}

/** Sample shape: 10 alnum chars; algorithm unpublished (unverified). */
export function generateSignature(): string {
  return randomAlnum(10);
}

function randomAlnum(length: number): string {
  return randomFrom('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', length);
}

function randomFrom(alphabet: string, length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) {
    out += alphabet[byte % alphabet.length];
  }
  return out;
}

/**
 * Doc-sample datetime: yyyy-MM-dd'T'HH:mm:ss:SSS GMT+0600 (note the colon
 * before millis). Dhaka has no DST, so +06:00 is a fixed offset.
 */
export function formatBkashDatetime(date: Date): string {
  const dhaka = new Date(date.getTime() + 6 * 3_600_000);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${dhaka.getUTCFullYear()}-${pad(dhaka.getUTCMonth() + 1)}-${pad(dhaka.getUTCDate())}` +
    `T${pad(dhaka.getUTCHours())}:${pad(dhaka.getUTCMinutes())}:${pad(dhaka.getUTCSeconds())}` +
    `:${pad(dhaka.getUTCMilliseconds(), 3)} GMT+0600`
  );
}

export function formatAmountMinor(amountMinor: number): string {
  return (amountMinor / 100).toFixed(2);
}

/**
 * Parse a decimal amount string to minor units. Rejects unparseable,
 * non-positive and >2dp values (simulator strictness, documented).
 */
export function parseAmountToMinor(input: string): { ok: true; minor: number } | { ok: false } {
  const trimmed = input.trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match?.[1]) return { ok: false };
  const minor = Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
  if (!Number.isSafeInteger(minor) || minor <= 0) return { ok: false };
  return { ok: true, minor };
}

/** Obvious fixture wallet; real-looking numbers never invented. */
export const FIXTURE_PAYER_ACCOUNT = '01700000000';

/**
 * Resolve the wallet number echoed in responses: a numeric 11-digit
 * payerReference presets it (per docs), otherwise the fixture.
 */
export function payerAccountFor(payerReference: string): string {
  return /^01\d{9}$/.test(payerReference) ? payerReference : FIXTURE_PAYER_ACCOUNT;
}

export interface CallbackUrls {
  success: string;
  failure: string;
  cancelled: string;
}

const CALLBACK_STATUSES = {
  success: 'success',
  failure: 'failure',
  cancelled: 'cancel',
} as const;

export function buildCallbackUrls(
  base: string,
  paymentId: string,
  signature: string,
): CallbackUrls {
  const build = (status: string): string => {
    const url = new URL(base);
    url.searchParams.set('paymentID', paymentId);
    url.searchParams.set('status', status);
    url.searchParams.set('signature', signature);
    return url.toString();
  };
  return {
    success: build(CALLBACK_STATUSES.success),
    failure: build(CALLBACK_STATUSES.failure),
    cancelled: build(CALLBACK_STATUSES.cancelled),
  };
}

export interface CreateResponseInput {
  paymentId: string;
  paymentCreateTime: string;
  amountMinor: number;
  currency: string;
  intent: string;
  merchantInvoiceNumber: string;
  bkashUrl: string;
  callbackURL: string;
  callbacks: CallbackUrls;
  signature: string;
}

export function buildCreateResponse(input: CreateResponseInput): Record<string, string> {
  return {
    paymentId: input.paymentId,
    bkashURL: input.bkashUrl,
    callbackURL: input.callbackURL,
    successCallbackURL: input.callbacks.success,
    failureCallbackURL: input.callbacks.failure,
    cancelledCallbackURL: input.callbacks.cancelled,
    amount: formatAmountMinor(input.amountMinor),
    intent: input.intent,
    currency: input.currency,
    paymentCreateTime: input.paymentCreateTime,
    transactionStatus: 'Initiated',
    merchantInvoiceNumber: input.merchantInvoiceNumber,
    signature: input.signature,
  };
}

export interface ExecuteResponseInput {
  paymentId: string;
  trxId: string;
  amountMinor: number;
  currency: string;
  intent: string;
  paymentExecuteTime: string;
  merchantInvoiceNumber: string;
  subMerchantName: string;
  payerReference: string;
  payerAccount: string;
}

export function buildExecuteResponse(input: ExecuteResponseInput): Record<string, string> {
  return {
    paymentId: input.paymentId,
    trxId: input.trxId,
    transactionStatus: 'Completed',
    amount: formatAmountMinor(input.amountMinor),
    currency: input.currency,
    intent: input.intent,
    paymentExecuteTime: input.paymentExecuteTime,
    merchantInvoiceNumber: input.merchantInvoiceNumber,
    subMerchantName: input.subMerchantName,
    payerType: 'Customer',
    payerReference: input.payerReference,
    payerAccount: input.payerAccount,
    maxRefundableAmount: formatAmountMinor(input.amountMinor),
  };
}

export interface QueryResponseInput extends ExecuteResponseInput {
  paymentCreateTime: string;
  paymentUpdateTime: string;
  transactionStatus: 'Completed' | 'Initiated';
  verificationStatus: 'Complete' | 'Incomplete';
}

export function buildQueryResponse(input: QueryResponseInput): Record<string, string> {
  // Samples show execute/update/trx timestamps only once Completed.
  const completed = input.transactionStatus === 'Completed';
  return {
    paymentId: input.paymentId,
    verificationStatus: input.verificationStatus,
    payerReference: input.payerReference,
    payerAccount: input.payerAccount,
    payerType: 'Customer',
    paymentCreateTime: input.paymentCreateTime,
    ...(completed
      ? {
          paymentExecuteTime: input.paymentExecuteTime,
          paymentUpdateTime: input.paymentUpdateTime,
          trxId: input.trxId,
        }
      : {}),
    amount: formatAmountMinor(input.amountMinor),
    currency: input.currency,
    intent: input.intent,
    merchantInvoice: input.merchantInvoiceNumber,
    transactionStatus: input.transactionStatus,
    subMerchantName: input.subMerchantName,
    maxRefundableAmount: formatAmountMinor(input.amountMinor),
  };
}
