import { describe, expect, it } from 'vitest';

import { sslcommerzPlugin } from '../src/index.js';

describe('sslcommerz spec manifest', () => {
  it('loads a schema-valid manifest (import itself parses it)', () => {
    expect(sslcommerzPlugin.spec.gateway).toBe('sslcommerz');
    expect(sslcommerzPlugin.spec.fidelity).toBe('docs-only');
  });

  it('marks the Phase 1 endpoints implemented + verified', () => {
    const byPath = new Map(
      sslcommerzPlugin.spec.endpoints.map((endpoint) => [
        `${endpoint.method} ${endpoint.path}`,
        endpoint,
      ]),
    );
    expect(byPath.get('POST /gwprocess/v4/api.php')).toMatchObject({
      implemented: true,
      fidelity: 'verified',
    });
    expect(byPath.get('GET /validator/api/validationserverAPI.php')).toMatchObject({
      implemented: true,
      fidelity: 'verified',
    });
    expect(byPath.get('GET /validator/api/merchantTransIDvalidationAPI.php')).toMatchObject({
      implemented: false,
    });
  });

  it('gives every verified field at least one source', () => {
    for (const field of sslcommerzPlugin.spec.fields) {
      if (field.fidelity === 'verified') {
        expect(field.sources.length, field.name).toBeGreaterThan(0);
      }
    }
  });

  it('validates credentials strictly', () => {
    expect(
      sslcommerzPlugin.validateCredentials({ store_id: 'testbox', store_passwd: 'qwerty' }).ok,
    ).toBe(true);
    const bad = sslcommerzPlugin.validateCredentials({ store_id: 'x' });
    expect(bad.ok).toBe(false);
  });
});
