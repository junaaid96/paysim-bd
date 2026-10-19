import { describe, expect, it } from 'vitest';

import { bkashPlugin } from '../src/index.js';

describe('bkash spec manifest', () => {
  it('loads a schema-valid manifest (import itself parses it)', () => {
    expect(bkashPlugin.spec.gateway).toBe('bkash');
    expect(bkashPlugin.spec.fidelity).toBe('docs-only');
  });

  it('marks the checkout endpoints implemented + verified', () => {
    const byPath = new Map(
      bkashPlugin.spec.endpoints.map((endpoint) => [
        `${endpoint.method} ${endpoint.path}`,
        endpoint,
      ]),
    );
    for (const key of [
      'POST /v2/tokenized-checkout/auth/grant-token',
      'POST /v2/tokenized-checkout/auth/refresh-token',
      'POST /v2/tokenized-checkout/payment/create',
      'POST /v2/tokenized-checkout/payment/execute',
      'POST /v2/tokenized-checkout/query/payment',
    ]) {
      expect(byPath.get(key)).toMatchObject({ implemented: true, fidelity: 'verified' });
    }
    expect(byPath.get('GET /bkash/checkout')).toMatchObject({
      implemented: true,
      fidelity: 'unverified',
    });
  });

  it('gives every verified field at least one source', () => {
    for (const field of bkashPlugin.spec.fields) {
      if (field.fidelity === 'verified') {
        expect(field.sources.length, field.name).toBeGreaterThan(0);
      }
    }
  });

  it('validates credentials strictly', () => {
    expect(
      bkashPlugin.validateCredentials({
        app_key: 'k',
        app_secret: 's',
        username: 'u',
        password: 'p',
      }).ok,
    ).toBe(true);
    const bad = bkashPlugin.validateCredentials({ app_key: 'k' });
    expect(bad.ok).toBe(false);
  });
});
