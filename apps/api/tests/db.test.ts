import { describe, expect, it, vi } from 'vitest';

import { sslForDatabaseUrl, waitForDb, type Db } from '../src/db/client.js';

describe('sslForDatabaseUrl', () => {
  it('requires TLS for sslmode=require (Neon pooled strings)', () => {
    expect(sslForDatabaseUrl('postgres://u:p@ep-xyz.pooler.neon.tech/db?sslmode=require')).toBe(
      'require',
    );
  });

  it('disables TLS for sslmode=disable (local Postgres without TLS)', () => {
    expect(
      sslForDatabaseUrl('postgres://paysim:paysim@localhost:5432/paysim?sslmode=disable'),
    ).toBe(false);
  });

  it('prefers TLS when sslmode is absent or prefer', () => {
    expect(sslForDatabaseUrl('postgres://paysim:paysim@localhost:5432/paysim')).toBe('prefer');
    expect(sslForDatabaseUrl('postgres://h/db?sslmode=prefer')).toBe('prefer');
  });

  it('fails loudly on verification modes it cannot honour', () => {
    expect(() => sslForDatabaseUrl('postgres://h/db?sslmode=verify-full')).toThrow(/sslmode/);
    expect(() => sslForDatabaseUrl('postgres://h/db?sslmode=bogus')).toThrow(/sslmode/);
  });
});

describe('waitForDb', () => {
  function stubDb(failuresBeforeSuccess: number): { db: Db; execute: ReturnType<typeof vi.fn> } {
    let calls = 0;
    const execute = vi.fn(async () => {
      calls += 1;
      if (calls <= failuresBeforeSuccess) {
        throw new Error('connection refused');
      }
      return [];
    });
    return { db: { execute } as unknown as Db, execute };
  }

  it('returns immediately when the database answers', async () => {
    const { db, execute } = stubDb(0);
    await waitForDb(db, { maxElapsedMs: 5_000 });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('retries with backoff until the database wakes', async () => {
    const { db, execute } = stubDb(2);
    await waitForDb(db, { maxElapsedMs: 10_000 });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('throws the last error when the budget is spent', async () => {
    const { db } = stubDb(Number.MAX_SAFE_INTEGER);
    await expect(waitForDb(db, { maxElapsedMs: 400 })).rejects.toThrow(/connection refused/);
  });
});
