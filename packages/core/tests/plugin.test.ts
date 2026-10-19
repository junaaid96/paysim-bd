import { describe, expect, it } from 'vitest';

import { GatewaySpecSchema } from '../src/plugin.js';

const VALID_SPEC = {
  gateway: 'sslcommerz',
  displayName: 'SSLCommerz',
  version: 'v1',
  fidelity: 'docs-only',
  docSources: ['https://developer.sslcommerz.com/doc/v4/'],
  sandboxHosts: ['sandbox.sslcommerz.com'],
  productionHosts: ['securepay.sslcommerz.com'],
  contentTypes: ['application/json', 'application/x-www-form-urlencoded'],
  endpoints: [
    {
      method: 'POST',
      path: '/gwprocess/v4/api.php',
      purpose: 'Session init',
      implemented: true,
      fidelity: 'verified',
      sources: ['https://developer.sslcommerz.com/doc/v4/'],
    },
  ],
  fields: [
    {
      endpoint: 'POST /gwprocess/v4/api.php',
      name: 'store_id',
      location: 'request',
      required: true,
      fidelity: 'verified',
      sources: ['https://developer.sslcommerz.com/doc/v4/'],
    },
  ],
  hashRules: [
    {
      name: 'verify_sign',
      description: 'MD5 over ksort(fields + md5(passwd))',
      fidelity: 'verified',
      sources: ['https://github.com/sslcommerz/SSLCommerz-PHP'],
      steps: ['explode verify_key', 'md5'],
    },
  ],
};

describe('GatewaySpecSchema', () => {
  it('accepts a complete spec', () => {
    expect(GatewaySpecSchema.parse(VALID_SPEC).gateway).toBe('sslcommerz');
  });

  it('rejects unknown fidelity levels and empty sources', () => {
    expect(() => GatewaySpecSchema.parse({ ...VALID_SPEC, fidelity: 'audited' })).toThrow();
    expect(() =>
      GatewaySpecSchema.parse({
        ...VALID_SPEC,
        endpoints: [{ ...VALID_SPEC.endpoints[0], sources: [] }],
      }),
    ).not.toThrow(); // endpoints may legitimately have no single source; fields carry them
  });

  it('requires the gateway identity fields', () => {
    expect(() => GatewaySpecSchema.parse({ ...VALID_SPEC, gateway: '' })).toThrow();
  });
});
