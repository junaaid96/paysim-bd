// Identifiers, timestamps and response shapes. Everything here is
// community-sourced or simulator-invented (spec/v1.json); formats that
// merchants treat as opaque are prefixed SIM so they cannot be mistaken
// for real Nagad values.

import { randomBytes } from 'node:crypto';

/** Opaque reference: SIMREF + 16 uppercase alnum (simulator-generated). */
export function generatePaymentReferenceId(): string {
  return `SIMREF${randomFrom('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 16)}`;
}

/** Community shape: 40 lowercase letters (nagadpy generate_challenge). */
export function generateChallenge(): string {
  return randomFrom('abcdefghijklmnopqrstuvwxyz', 40);
}

/** Simulator trx id for verify responses (merchants treat it as opaque). */
export function generateSimTrxId(): string {
  return `SIMTRX${randomBytes(5).toString('hex').toUpperCase()}`;
}

function randomFrom(alphabet: string, length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) {
    out += alphabet[byte % alphabet.length];
  }
  return out;
}

/** Community timestamp: YYYYMMDDHHMMSS in Asia/Dhaka (no DST). */
export function formatNagadDatetime(date: Date): string {
  const dhaka = new Date(date.getTime() + 6 * 3_600_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${dhaka.getUTCFullYear()}${pad(dhaka.getUTCMonth() + 1)}${pad(dhaka.getUTCDate())}` +
    `${pad(dhaka.getUTCHours())}${pad(dhaka.getUTCMinutes())}${pad(dhaka.getUTCSeconds())}`
  );
}

export function formatAmountMinor(amountMinor: number): string {
  return (amountMinor / 100).toFixed(2);
}

/**
 * Parse a decimal amount string to minor units. Community clients send
 * "100.00"; zero/negative/unparseable and >2dp values are rejected.
 */
export function parseAmountToMinor(input: string): { ok: true; minor: number } | { ok: false } {
  const trimmed = input.trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match?.[1]) return { ok: false };
  const minor = Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
  if (!Number.isSafeInteger(minor) || minor <= 0) return { ok: false };
  return { ok: true, minor };
}

export interface CallbackParams {
  merchant: string;
  orderId: string;
  paymentRefId: string;
  status: 'Success' | 'Fail' | 'Cancel';
}

export function buildCallbackUrl(base: string, params: CallbackParams): string {
  const url = new URL(base);
  url.searchParams.set('merchant', params.merchant);
  url.searchParams.set('order_id', params.orderId);
  url.searchParams.set('payment_ref_id', params.paymentRefId);
  url.searchParams.set('status', params.status);
  return url.toString();
}
