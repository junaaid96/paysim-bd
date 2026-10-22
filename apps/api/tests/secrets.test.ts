import { describe, expect, it } from 'vitest';

import { decryptJson, encryptJson, maskSecret, secretsConfigured } from '../src/secrets.js';

describe('sandbox key encryption', () => {
  const key = 'test-only-secrets-key-0123456789';

  it('round-trips and never stores plaintext', () => {
    const blob = encryptJson({ store_id: 'mystore', store_passwd: 'hunter2' }, key);
    expect(blob).not.toContain('hunter2');
    expect(decryptJson(blob, key)).toEqual({ store_id: 'mystore', store_passwd: 'hunter2' });
  });

  it('rejects a wrong key or tampered data', () => {
    const blob = encryptJson({ a: 'b' }, key);
    expect(decryptJson(blob, 'other-key')).toBeNull();
    const parts = blob.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(decryptJson(parts.join(':'), key)).toBeNull();
  });

  it('requires a configured key and masks hints', () => {
    expect(secretsConfigured('')).toBe(false);
    expect(() => encryptJson({ a: 'b' }, '')).toThrow();
    expect(maskSecret('abcdefghijkl')).toBe('••••ijkl');
    expect(maskSecret('abcdefgh')).toBe('••••gh');
    expect(maskSecret('qwerty')).toBe('••••');
    expect(maskSecret('abc')).toBe('••••');
  });
});
