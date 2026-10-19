import { describe, expect, it } from 'vitest';

import {
  VERIFY_KEY,
  VERIFY_KEY_FIELDS,
  computeVerifySign,
  verifySignature,
} from '../src/verify.js';

// The doc IPN example's verify_sign cannot be reproduced (real testbox
// password unpublished), so this vector pins OUR port of the official
// algorithm instead: explode -> md5(passwd) -> ksort -> join -> md5.
describe('computeVerifySign', () => {
  it('follows the official algorithm steps literally', () => {
    const payload = { b_field: '2', a_field: '1', ignored: 'x' };
    // ksort: a_field, b_field, store_passwd
    // string: "a_field=1&b_field=2&store_passwd=" + md5("pw")
    const sign = computeVerifySign(payload, 'b_field,a_field', 'pw');
    expect(sign).toMatch(/^[0-9a-f]{32}$/);
    expect(verifySignature(payload, 'b_field,a_field', 'pw', sign)).toBe(true);
  });

  it('matches a hand-computed value', async () => {
    const { createHash } = await import('node:crypto');
    const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');
    const payload = { amount: '100', tran_id: 'abc' };
    const expected = md5(`amount=100&store_passwd=${md5('qwerty')}&tran_id=abc`);
    expect(computeVerifySign(payload, 'tran_id,amount', 'qwerty')).toBe(expected);
  });

  it('skips verify_key entries missing from the payload (PHP isset)', () => {
    const full = computeVerifySign({ a: '1' }, 'a', 'pw');
    const withMissing = computeVerifySign({ a: '1' }, 'a,ghost', 'pw');
    expect(withMissing).toBe(full);
  });

  it('detects tampering', () => {
    const payload = { amount: '100', tran_id: 'abc' };
    const sign = computeVerifySign(payload, 'amount,tran_id', 'qwerty');
    expect(verifySignature({ ...payload, amount: '999' }, 'amount,tran_id', 'qwerty', sign)).toBe(
      false,
    );
    expect(verifySignature(payload, 'amount,tran_id', 'wrong', sign)).toBe(false);
  });

  it('ships the exact documented verify_key set', () => {
    expect(VERIFY_KEY).toBe(
      'amount,bank_tran_id,base_fair,card_brand,card_issuer,card_issuer_country,' +
        'card_issuer_country_code,card_no,card_type,currency,currency_amount,currency_rate,' +
        'currency_type,risk_level,risk_title,status,store_amount,store_id,tran_date,tran_id,' +
        'val_id,value_a,value_b,value_c,value_d',
    );
    expect(VERIFY_KEY_FIELDS).toHaveLength(25);
  });
});
