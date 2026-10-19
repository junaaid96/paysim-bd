import { describe, expect, it } from 'vitest';

import { REDACTED } from '../src/constants.js';
import { redactHeaders, redactValue, truncateUtf8, utf8ByteLength } from '../src/redact.js';

describe('redactValue', () => {
  it('redacts known secret keys at any depth', () => {
    const input = {
      tran_id: 'abc123',
      store_passwd: 's3cr3t',
      nested: { password: 'hunter2', amount: 100 },
      list: [{ api_key: 'key-1', ok: true }],
    };
    expect(redactValue(input)).toEqual({
      tran_id: 'abc123',
      store_passwd: REDACTED,
      nested: { password: REDACTED, amount: 100 },
      list: [{ api_key: REDACTED, ok: true }],
    });
  });

  it('matches secret keys case-insensitively, including long forms', () => {
    const input = {
      Password: 'a',
      CLIENT_SECRET: 'b',
      card_number: 'c',
      verify_sign: 'd',
      storePasswd: 'e',
      sensitiveData: 'f',
      sensitive_data: 'g',
    };
    const out = redactValue(input) as Record<string, string>;
    expect(Object.values(out).every((v) => v === REDACTED)).toBe(true);
  });

  it('redacts bearer/basic token strings even under innocent keys', () => {
    expect(redactValue({ note: 'Bearer abc.def.ghi' })).toEqual({ note: REDACTED });
    expect(redactValue('Basic dXNlcjpwYXNz')).toBe(REDACTED);
  });

  it('leaves non-secret values untouched and does not mutate the input', () => {
    const input = { amount: 1500, currency: 'BDT', items: ['a', 'b'] };
    const out = redactValue(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it('survives circular structures', () => {
    const input: Record<string, unknown> = { a: 1 };
    input['self'] = input;
    expect(redactValue(input)).toEqual({ a: 1, self: '[Circular]' });
  });

  it('passes primitives through', () => {
    expect(redactValue(null)).toBeNull();
    expect(redactValue(42)).toBe(42);
    expect(redactValue(true)).toBe(true);
    expect(redactValue('plain note')).toBe('plain note');
  });
});

describe('redactHeaders', () => {
  it('redacts authorization, cookie and api-key headers', () => {
    expect(
      redactHeaders({
        'content-type': 'application/json',
        authorization: 'Bearer xyz',
        Cookie: 'session=abc',
        'X-API-Key': 'key',
      }),
    ).toEqual({
      'content-type': 'application/json',
      authorization: REDACTED,
      Cookie: REDACTED,
      'X-API-Key': REDACTED,
    });
  });
});

describe('truncateUtf8', () => {
  it('returns short strings unchanged', () => {
    expect(truncateUtf8('hello', 16)).toBe('hello');
  });

  it('truncates on byte length and marks truncation', () => {
    expect(truncateUtf8('hello world', 5)).toBe('hello…');
  });

  it('never splits a multi-byte code point', () => {
    // 'é' is 2 bytes in UTF-8; a cut at byte 1 must back off to byte 0.
    expect(truncateUtf8('éclair', 1)).toBe('…');
    expect(truncateUtf8('abécd', 3)).toBe('ab…');
  });

  it('agrees with utf8ByteLength', () => {
    expect(utf8ByteLength('hello')).toBe(5);
    expect(utf8ByteLength('é')).toBe(2);
  });
});
