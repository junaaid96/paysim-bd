// Small Upay value helpers. Amounts are decimal strings in BDT ("100.00").

import { randomBytes } from 'node:crypto';

export function formatAmountMinor(minor: number): string {
  return (minor / 100).toFixed(2);
}

export function parseAmountToMinor(value: unknown): { ok: true; minor: number } | { ok: false } {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text.trim())) return { ok: false };
  const minor = Math.round(Number(text) * 100);
  return minor > 0 ? { ok: true, minor } : { ok: false };
}

export function simId(prefix: string, bytes = 8): string {
  return `${prefix}${randomBytes(bytes).toString('hex').toUpperCase()}`;
}

/** Today in Asia/Dhaka as YYYY-MM-DD (the init `date` field). */
export function dhakaDate(now = new Date()): string {
  return new Date(now.getTime() + 6 * 3600_000).toISOString().slice(0, 10);
}

/**
 * Upay returns the customer to redirect_url with `status` and `invoice_id`
 * appended (BDPayGate UpayGateway.php notes it may append "&..." even when
 * the URL has no query, so merchants must parse leniently). The simulator
 * appends with the correct separator.
 */
export function buildRedirectUrl(base: string, status: string, invoiceId: string): string {
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}status=${encodeURIComponent(status)}&invoice_id=${encodeURIComponent(invoiceId)}`;
}
