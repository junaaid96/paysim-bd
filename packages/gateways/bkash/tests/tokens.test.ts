import { describe, expect, it } from 'vitest';

import { createTokenStore, ID_TOKEN_TTL_MS } from '../src/tokens.js';

describe('token store', () => {
  it('issues, resolves and expires id_tokens on the given clock', () => {
    const store = createTokenStore();
    const now = Date.now();
    const issued = store.issue('app-1', now);
    expect(issued.idToken).toMatch(/^sim_id_[0-9a-f]{32}$/);
    expect(issued.refreshToken).toMatch(/^sim_rt_[0-9a-f]{32}$/);
    expect(issued.expiresIn).toBe(3600);
    expect(store.resolve(issued.idToken, now + 1000)).toBe('app-1');
    expect(store.peek(issued.idToken)).toBe('app-1');
    expect(store.resolve(issued.idToken, now + ID_TOKEN_TTL_MS)).toBeNull();
    expect(store.resolve('sim_id_nope', now)).toBeNull();
  });

  it('rotates refresh tokens, invalidating the previous pair', () => {
    const store = createTokenStore();
    const now = Date.now();
    const first = store.issue('app-1', now);
    const second = store.refresh('app-1', first.refreshToken, now + 1000);
    expect(second).not.toBeNull();
    expect(second?.idToken).not.toBe(first.idToken);
    // Old pair is dead: refresh-token reuse and old id_token both fail.
    expect(store.refresh('app-1', first.refreshToken, now + 2000)).toBeNull();
    expect(store.resolve(first.idToken, now + 2000)).toBeNull();
    expect(store.resolve(second?.idToken ?? '', now + 2000)).toBe('app-1');
    // Foreign app cannot use the token.
    expect(store.refresh('app-2', second?.refreshToken ?? '', now + 2000)).toBeNull();
  });
});
