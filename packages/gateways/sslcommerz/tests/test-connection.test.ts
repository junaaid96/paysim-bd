// Real-sandbox connection test with MOCKED provider responses (no network).
import { afterEach, describe, expect, it } from 'vitest';

import type { AppRecord } from '@paysim/core';

import { setSslczFetch, sslcommerzSandbox } from '../src/real.js';

const app = { id: '00000000-0000-4000-8000-000000000001' } as AppRecord;
const keys = { store_id: 'mystore', store_passwd: 'mysecret' };

function mock(body: unknown): string[] {
  const urls: string[] = [];
  setSslczFetch((async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch);
  return urls;
}

describe('sslcommerz testConnection', () => {
  afterEach(() => setSslczFetch(null));

  it('reports connected when the provider answers APIConnect=DONE', async () => {
    const urls = mock({ APIConnect: 'DONE', no_of_trans_found: 0 });
    const result = await sslcommerzSandbox.testConnection!({}, app, keys);
    expect(result.ok).toBe(true);
    expect(urls[0]).toContain('/validator/api/merchantTransIDvalidationAPI.php');
    expect(urls[0]).toContain('store_id=mystore');
  });

  it('reports an error for rejected credentials', async () => {
    mock({ APIConnect: 'FAILED', no_of_trans_found: 0 });
    const result = await sslcommerzSandbox.testConnection!({}, app, keys);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('FAILED');
  });
});
