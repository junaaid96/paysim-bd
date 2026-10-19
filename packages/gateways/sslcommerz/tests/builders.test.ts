import { describe, expect, it } from 'vitest';

import {
  GW_CATEGORIES,
  buildCallbackPayload,
  buildInitFailure,
  buildInitResponse,
  buildIpnPayload,
  buildValidationResponse,
  formatAmount,
  generateRefId,
  generateSessionKey,
  DEFAULT_CARD_FIXTURE,
} from '../src/builders.js';
import { VERIFY_KEY, verifySignature } from '../src/verify.js';

const IPN_BASE = {
  tranId: 'ORDER1',
  valId: 'VAL1',
  amountMinor: 10300,
  currencyType: 'BDT',
  storeId: 'testbox',
  storePasswd: 'qwerty',
  bankTranId: 'BANK1',
  tranDate: '2026-10-20 01:00:00',
  card: DEFAULT_CARD_FIXTURE,
  values: { a: 'ref001', b: '', c: 'ref003', d: 'ref004' },
};

describe('id generation', () => {
  it('generates 32-hex-uppercase session keys', () => {
    expect(generateSessionKey()).toMatch(/^[0-9A-F]{32}$/);
  });

  it('generates 26-char reference ids', () => {
    expect(generateRefId(1709162025351)).toMatch(/^1709162025351[A-Za-z0-9]{13}$/);
  });

  it('formats minor units as 2dp decimals', () => {
    expect(formatAmount(10300)).toBe('103.00');
    expect(formatAmount(5)).toBe('0.05');
  });
});

describe('buildInitResponse', () => {
  it('returns the documented shape', () => {
    const res = buildInitResponse({
      sessionkey: 'ABC',
      gatewayPageUrl: 'http://sim.test/gwprocess/v4/gw.php?Q=PAY&SESSIONKEY=ABC',
    });
    expect(res['status']).toBe('SUCCESS');
    expect(res['failedreason']).toBe('');
    expect(res['sessionkey']).toBe('ABC');
    expect(res['gw']).toEqual(GW_CATEGORIES);
    expect(Object.keys(res['gw'] as object).sort()).toEqual(
      ['amex', 'internetbanking', 'master', 'mobilebanking', 'othercards', 'visa'].sort(),
    );
    expect(res['GatewayPageURL']).toContain('SESSIONKEY=ABC');
    expect(res['storeBanner']).toBe('');
    expect(res['storeLogo']).toBe('');
    expect(Array.isArray(res['desc'])).toBe(true);
    expect((res['desc'] as Array<{ logo: string }>).every((d) => d.logo === '')).toBe(true);
  });

  it('builds failures', () => {
    expect(buildInitFailure('nope')).toEqual({ status: 'FAILED', failedreason: 'nope' });
  });
});

describe('buildIpnPayload', () => {
  it('covers the full verify_key set with a valid signature', () => {
    const payload = buildIpnPayload({ ...IPN_BASE, ipnStatus: 'VALID' });
    for (const field of VERIFY_KEY.split(',')) {
      expect(payload[field]).toBeDefined();
    }
    expect(payload['verify_key']).toBe(VERIFY_KEY);
    expect(
      verifySignature(
        payload,
        payload['verify_key'] as string,
        'qwerty',
        payload['verify_sign'] as string,
      ),
    ).toBe(true);
  });

  it('blanks val_id unless VALID', () => {
    expect(buildIpnPayload({ ...IPN_BASE, ipnStatus: 'VALID' })['val_id']).toBe('VAL1');
    expect(buildIpnPayload({ ...IPN_BASE, ipnStatus: 'FAILED' })['val_id']).toBe('');
    expect(buildIpnPayload({ ...IPN_BASE, ipnStatus: 'CANCELLED' })['val_id']).toBe('');
  });

  it('merges cus/ship echoes outside the signed set', () => {
    const payload = buildIpnPayload({
      ...IPN_BASE,
      ipnStatus: 'VALID',
      echoes: { cus_fax: '01711111111' },
    });
    expect(payload['cus_fax']).toBe('01711111111');
    expect(
      verifySignature(
        payload,
        payload['verify_key'] as string,
        'qwerty',
        payload['verify_sign'] as string,
      ),
    ).toBe(true);
  });
});

describe('buildValidationResponse', () => {
  it('returns the documented field set', () => {
    const res = buildValidationResponse({
      ...IPN_BASE,
      validationStatus: 'VALIDATED',
      validatedOn: '2026-10-20 01:02:00',
    });
    for (const key of [
      'status',
      'tran_date',
      'tran_id',
      'val_id',
      'amount',
      'store_amount',
      'currency',
      'bank_tran_id',
      'card_type',
      'card_no',
      'card_issuer',
      'card_brand',
      'card_issuer_country',
      'card_issuer_country_code',
      'currency_type',
      'currency_amount',
      'currency_rate',
      'base_fair',
      'value_a',
      'value_b',
      'value_c',
      'value_d',
      'emi_instalment',
      'emi_amount',
      'emi_description',
      'emi_issuer',
      'account_details',
      'risk_title',
      'risk_level',
      'APIConnect',
      'validated_on',
      'gw_version',
    ]) {
      expect(res[key], key).toBeDefined();
    }
    expect(res['status']).toBe('VALIDATED');
    expect(res['APIConnect']).toBe('DONE');
    expect(res['amount']).toBe('103.00');
  });
});

describe('buildCallbackPayload', () => {
  const base = {
    tranId: 'ORDER1',
    valId: 'VAL1',
    amountMinor: 10300,
    storeId: 'testbox',
    storePasswd: 'qwerty',
    bankTranId: 'BANK1',
    tranDate: '2026-10-20 01:00:00',
    card: DEFAULT_CARD_FIXTURE,
    errorText: 'boom',
  };

  it('success carries val_id and VALID status with a valid signature', () => {
    const payload = buildCallbackPayload({ ...base, kind: 'success' });
    expect(payload['val_id']).toBe('VAL1');
    expect(payload['status']).toBe('VALID');
    expect(payload['error']).toBeUndefined();
    expect(
      verifySignature(
        payload,
        payload['verify_key'] as string,
        'qwerty',
        payload['verify_sign'] as string,
      ),
    ).toBe(true);
  });

  it('fail/cancel carry error text instead of val_id', () => {
    const fail = buildCallbackPayload({ ...base, kind: 'fail' });
    expect(fail['status']).toBe('FAILED');
    expect(fail['error']).toBe('boom');
    expect(fail['val_id']).toBeUndefined();
    const cancel = buildCallbackPayload({ ...base, kind: 'cancel' });
    expect(cancel['status']).toBe('CANCELLED');
    expect(cancel['error']).toBe('boom');
  });
});
