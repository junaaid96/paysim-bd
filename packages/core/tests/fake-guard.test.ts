import { describe, expect, it } from 'vitest';

import { formatDbDatetime, SystemClock } from '../src/clock.js';
import { FakeCredentialError, assertFakeCredentials } from '../src/fake-guard.js';

const HOSTS = ['sandbox.sslcommerz.com', 'securepay.sslcommerz.com'];

describe('SystemClock', () => {
  it('returns wall-clock time for any workspace', () => {
    const before = Date.now();
    const now = new SystemClock().now('any-workspace');
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('formatDbDatetime', () => {
  it('formats UTC as YYYY-MM-DD HH:MM:SS', () => {
    expect(formatDbDatetime(new Date('2017-09-16T20:25:27.000Z'))).toBe('2017-09-16 20:25:27');
  });
});

describe('assertFakeCredentials', () => {
  it('accepts obviously-fake values', () => {
    expect(() =>
      assertFakeCredentials(HOSTS, { store_id: 'testbox', store_passwd: 'qwerty-sim' }),
    ).not.toThrow();
  });

  it('rejects real gateway hosts anywhere in the credentials', () => {
    expect(() =>
      assertFakeCredentials(HOSTS, {
        store_id: 'x',
        webhook: 'https://securepay.sslcommerz.com/x',
      }),
    ).toThrow(FakeCredentialError);
    expect(() =>
      assertFakeCredentials(HOSTS, { nested: { v: 'https://sandbox.sslcommerz.com/' } }),
    ).toThrow(/real gateway infrastructure/);
  });

  it('rejects production-looking words', () => {
    expect(() => assertFakeCredentials(HOSTS, { store_id: 'my-live-store' })).toThrow(
      /production credential/,
    );
    expect(() => assertFakeCredentials(HOSTS, { store_id: 'prod-account' })).toThrow(
      FakeCredentialError,
    );
  });

  it('does not flag innocent substrings', () => {
    // \b word boundaries: "live" inside "deliver" must not trip the guard.
    expect(() => assertFakeCredentials(HOSTS, { note: 'deliver to test' })).not.toThrow();
  });

  it('ignores non-string values', () => {
    expect(() =>
      assertFakeCredentials(HOSTS, { port: 3001, enabled: true, nothing: null }),
    ).not.toThrow();
  });
});
