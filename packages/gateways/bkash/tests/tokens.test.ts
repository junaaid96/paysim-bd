import { describe, expect, it } from 'vitest';

import { createMemoryKv, createTokenStore, ID_TOKEN_TTL_MS } from '../src/tokens.js';

describe('token store', () => {
  it('issues, resolves and expires id_tokens on the given clock', async () => {
    const store = createTokenStore();
    const now = Date.now();
    const issued = await store.issue('app-1', now);
    expect(issued.idToken).toMatch(/^sim_id_[0-9a-f]{32}$/);
    expect(issued.refreshToken).toMatch(/^sim_rt_[0-9a-f]{32}$/);
    expect(issued.expiresIn).toBe(3600);
    expect(await store.resolve(issued.idToken, now + 1000)).toBe('app-1');
    expect(await store.peek(issued.idToken)).toBe('app-1');
    expect(await store.resolve(issued.idToken, now + ID_TOKEN_TTL_MS)).toBeNull();
    expect(await store.resolve('sim_id_nope', now)).toBeNull();
  });

  it('rotates refresh tokens, invalidating the previous pair', async () => {
    const store = createTokenStore();
    const now = Date.now();
    const first = await store.issue('app-1', now);
    const second = await store.refresh('app-1', first.refreshToken, now + 1000);
    expect(second).not.toBeNull();
    expect(second?.idToken).not.toBe(first.idToken);
    // Old pair is dead: refresh-token reuse and old id_token both fail.
    expect(await store.refresh('app-1', first.refreshToken, now + 2000)).toBeNull();
    expect(await store.resolve(first.idToken, now + 2000)).toBeNull();
    expect(await store.resolve(second?.idToken ?? '', now + 2000)).toBe('app-1');
    // Foreign app cannot use the token.
    expect(await store.refresh('app-2', second?.refreshToken ?? '', now + 2000)).toBeNull();
  });

  it('shares tokens across stores backed by the same kv (serverless instances)', async () => {
    const kv = createMemoryKv();
    const a = createTokenStore(kv);
    const b = createTokenStore(kv);
    const now = Date.now();
    const issued = await a.issue('app-1', now);
    expect(await b.resolve(issued.idToken, now + 1000)).toBe('app-1');
    const rotated = await b.refresh('app-1', issued.refreshToken, now + 1000);
    expect(rotated).not.toBeNull();
    expect(await a.resolve(issued.idToken, now + 2000)).toBeNull();
  });
});
