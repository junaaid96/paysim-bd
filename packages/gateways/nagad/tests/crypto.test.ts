import { describe, expect, it } from 'vitest';

import {
  isParsableRsaPublicKey,
  NagadCryptoError,
  normalizePublicKeyPem,
  rsaDecrypt,
  rsaEncrypt,
  rsaSign,
  rsaVerify,
} from '../src/crypto.js';
import { loadFixtureKeys } from '../src/fixtures.js';

const fixture = loadFixtureKeys();

describe('nagad crypto', () => {
  it('round-trips merchant → simulator → merchant', () => {
    const request = JSON.stringify({ merchantId: 'M1', orderId: 'O1', challenge: 'abc' });
    const sealed = rsaEncrypt(fixture.publicPem, request);
    expect(rsaDecrypt(fixture.privatePem, sealed)).toBe(request);

    const response = JSON.stringify({ paymentReferenceId: 'SIMREF1', challenge: 'xyz' });
    const back = rsaEncrypt(fixture.merchantPublicPem, response);
    expect(rsaDecrypt(fixture.merchantPrivatePem, back)).toBe(response);
  });

  it('signs and verifies over the exact plaintext string', () => {
    const plaintext = '{"a":1}';
    const signature = rsaSign(fixture.merchantPrivatePem, plaintext);
    expect(rsaVerify(fixture.merchantPublicPem, plaintext, signature)).toBe(true);
    expect(rsaVerify(fixture.merchantPublicPem, '{"a":2}', signature)).toBe(false);
    expect(rsaVerify(fixture.merchantPublicPem, plaintext, 'not-base64!!!')).toBe(false);
    // Cross-key verification fails (wrong identity).
    expect(rsaVerify(fixture.publicPem, plaintext, signature)).toBe(false);
  });

  it('fails decrypt loudly on garbage and wrong keys', () => {
    expect(() => rsaDecrypt(fixture.privatePem, '!!!not-base64!!!')).toThrow(NagadCryptoError);
    // Valid base64, wrong ciphertext.
    expect(() => rsaDecrypt(fixture.privatePem, Buffer.from('nope').toString('base64'))).toThrow(
      /Cannot decrypt sensitiveData/,
    );
  });

  it('normalizes raw-base64 and PEM key inputs', () => {
    const raw = fixture.merchantPublicPem
      .replace('-----BEGIN PUBLIC KEY-----', '')
      .replace('-----END PUBLIC KEY-----', '');
    const normalized = normalizePublicKeyPem(raw);
    expect(normalized).toContain('BEGIN PUBLIC KEY');
    expect(rsaVerify(raw, '{"a":1}', rsaSign(fixture.merchantPrivatePem, '{"a":1}'))).toBe(true);
    expect(isParsableRsaPublicKey(fixture.merchantPublicPem)).toBe(true);
    expect(isParsableRsaPublicKey(raw)).toBe(true);
    expect(isParsableRsaPublicKey('garbage')).toBe(false);
    expect(isParsableRsaPublicKey('')).toBe(false);
  });
});
