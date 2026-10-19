import { describe, expect, it } from 'vitest';

import {
  buildCallbackUrls,
  buildPaymentError,
  formatAmountMinor,
  formatBkashDatetime,
  generatePaymentId,
  generateSignature,
  generateTrxId,
  parseAmountToMinor,
  payerAccountFor,
} from '../src/builders.js';

describe('bkash builders', () => {
  it('generates sample-shaped paymentIds, trxIds and signatures', () => {
    const id = generatePaymentId(1789885888970);
    expect(id).toMatch(/^TR0011[0-9A-Za-z]{7}1789885888970$/);
    expect(generateTrxId()).toMatch(/^[A-Z0-9]{9}$/);
    expect(generateSignature()).toMatch(/^[0-9A-Za-z]{10}$/);
  });

  it('formats datetimes like the samples (colon millis, GMT+0600)', () => {
    // 2026-09-20T12:31:28.970+06:00 == 06:31:28.970Z.
    const date = new Date('2026-09-20T06:31:28.970Z');
    expect(formatBkashDatetime(date)).toBe('2026-09-20T12:31:28:970 GMT+0600');
  });

  it('parses amounts strictly to minor units', () => {
    expect(parseAmountToMinor('2.90')).toEqual({ ok: true, minor: 290 });
    expect(parseAmountToMinor('20')).toEqual({ ok: true, minor: 2000 });
    expect(parseAmountToMinor(' 150.75 ')).toEqual({ ok: true, minor: 15075 });
    for (const bad of ['0', '0.00', '-5', 'abc', '', '2.999', '1,000', '2,90']) {
      expect(parseAmountToMinor(bad), bad).toEqual({ ok: false });
    }
    expect(formatAmountMinor(290)).toBe('2.90');
  });

  it('presets numeric payer references as the wallet, else the fixture', () => {
    expect(payerAccountFor('01770618575')).toBe('01770618575');
    expect(payerAccountFor('TEST001ABC')).toBe('01700000000');
  });

  it('appends callback params, preserving existing query strings', () => {
    const urls = buildCallbackUrls('https://merchant.test/cb?x=1', 'TR1', 'sig');
    expect(urls.success).toBe(
      'https://merchant.test/cb?x=1&paymentID=TR1&status=success&signature=sig',
    );
    expect(urls.failure).toContain('status=failure');
    expect(urls.cancelled).toContain('status=cancel');
  });

  it('builds the gateway error shape with null errorMessageBn', () => {
    expect(
      buildPaymentError({ externalCode: '2002', errorMessageEn: 'Invalid Payment ID' }),
    ).toEqual({ externalCode: '2002', errorMessageEn: 'Invalid Payment ID', errorMessageBn: null });
    expect(
      buildPaymentError({
        externalCode: '2002',
        errorMessageEn: 'Invalid Payment ID',
        internalCode: 'invalid_payment_id',
      }).internalCode,
    ).toBe('invalid_payment_id');
  });
});
