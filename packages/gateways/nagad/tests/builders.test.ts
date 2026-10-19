import { describe, expect, it } from 'vitest';

import {
  buildCallbackUrl,
  formatAmountMinor,
  formatNagadDatetime,
  generateChallenge,
  generatePaymentReferenceId,
  generateSimTrxId,
  parseAmountToMinor,
} from '../src/builders.js';

describe('nagad builders', () => {
  it('generates simulator-prefixed references and community-shaped challenges', () => {
    expect(generatePaymentReferenceId()).toMatch(/^SIMREF[A-Z0-9]{16}$/);
    expect(generateChallenge()).toMatch(/^[a-z]{40}$/);
    expect(generateSimTrxId()).toMatch(/^SIMTRX[0-9A-F]{10}$/);
  });

  it('formats Dhaka timestamps as YYYYMMDDHHMMSS', () => {
    // 2026-01-02T03:04:05+06:00 == 2025-12-31T21:04:05Z... use an exact instant.
    expect(formatNagadDatetime(new Date('2026-09-20T06:31:28.000Z'))).toBe('20260920123128');
  });

  it('parses amounts strictly to minor units', () => {
    expect(parseAmountToMinor('100.00')).toEqual({ ok: true, minor: 10000 });
    expect(parseAmountToMinor('20')).toEqual({ ok: true, minor: 2000 });
    for (const bad of ['0', '0.00', '-5', 'abc', '', '1.999']) {
      expect(parseAmountToMinor(bad), bad).toEqual({ ok: false });
    }
    expect(formatAmountMinor(10000)).toBe('100.00');
  });

  it('builds callback URLs with the community param set', () => {
    const url = buildCallbackUrl('https://merchant.test/cb', {
      merchant: 'M1',
      orderId: 'O1',
      paymentRefId: 'R1',
      status: 'Success',
    });
    expect(url).toBe(
      'https://merchant.test/cb?merchant=M1&order_id=O1&payment_ref_id=R1&status=Success',
    );
  });
});
