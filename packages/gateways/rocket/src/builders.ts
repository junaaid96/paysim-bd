// Small Rocket value helpers. The DBBL service takes amounts in paisa
// (legacy jar: amount*100, currency 050); the dashboard shows BDT.

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

/** DBBL-style transaction id: 28 base64 chars (20 random bytes). */
export function simTransId(): string {
  return randomBytes(20).toString('base64');
}
