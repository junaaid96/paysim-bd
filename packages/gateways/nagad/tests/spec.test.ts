import { describe, expect, it } from 'vitest';

import { nagadPlugin } from '../src/index.js';

describe('nagad spec manifest', () => {
  it('loads a schema-valid manifest (import itself parses it)', () => {
    expect(nagadPlugin.spec.gateway).toBe('nagad');
    expect(nagadPlugin.spec.fidelity).toBe('unverified');
  });

  it('marks every endpoint unverified with sources or a sim-only note', () => {
    for (const endpoint of nagadPlugin.spec.endpoints) {
      expect(endpoint.fidelity, `${endpoint.method} ${endpoint.path}`).toBe('unverified');
      const documented =
        endpoint.sources.length > 0 || (endpoint.notes ?? '').toLowerCase().includes('simulator');
      expect(documented, `${endpoint.method} ${endpoint.path}`).toBe(true);
    }
    const byPath = new Map(
      nagadPlugin.spec.endpoints.map((endpoint) => [
        `${endpoint.method} ${endpoint.path}`,
        endpoint,
      ]),
    );
    expect(
      byPath.get(
        'POST /remote-payment-gateway-1.0/api/dfs/check-out/initialize/{merchantId}/{orderId}',
      )?.implemented,
    ).toBe(true);
    expect(
      byPath.get('POST /remote-payment-gateway-1.0/api/dfs/check-out/refund/{merchantId}')
        ?.implemented,
    ).toBe(true);
  });

  it('validates credentials including the RSA public key', () => {
    expect(
      nagadPlugin.validateCredentials({
        merchant_id: 'M1',
        merchant_number: '01700000000',
        merchant_public_key: 'garbage',
      }).ok,
    ).toBe(false);
    const badNumber = nagadPlugin.validateCredentials({
      merchant_id: 'M1',
      merchant_number: '123',
      merchant_public_key: 'garbage',
    });
    expect(badNumber.ok).toBe(false);
    expect(nagadPlugin.validateCredentials(nagadPlugin.defaultCredentials).ok).toBe(true);
  });
});
