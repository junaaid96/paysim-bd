import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_INLINE_BODY_BYTES, REDACTED } from '@paysim/core';
import { afterEach, describe, expect, it } from 'vitest';

import { storeBody } from '../src/body-store.js';
import { FsStorageDriver } from '../src/storage/fs.js';

describe('storeBody', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeStorage(): Promise<FsStorageDriver> {
    const root = await mkdtemp(join(tmpdir(), 'paysim-body-'));
    dirs.push(root);
    return new FsStorageDriver(root);
  }

  it('keeps small bodies inline', async () => {
    const storage = await makeStorage();
    const stored = await storeBody(storage, 'events', { tran_id: 'abc', amount: 100 });
    expect(stored.key).toBeNull();
    expect(stored.inline).toBe(JSON.stringify({ tran_id: 'abc', amount: 100 }));
    expect(stored.sizeBytes).toBeLessThanOrEqual(MAX_INLINE_BODY_BYTES);
  });

  it('redacts secrets before storing', async () => {
    const storage = await makeStorage();
    const stored = await storeBody(storage, 'events', {
      tran_id: 'abc',
      store_passwd: 's3cr3t',
    });
    expect(stored.inline).toContain(REDACTED);
    expect(stored.inline).not.toContain('s3cr3t');
  });

  it('spills bodies over 16 KB to object storage', async () => {
    const storage = await makeStorage();
    const big = 'x'.repeat(MAX_INLINE_BODY_BYTES + 1);
    const stored = await storeBody(storage, 'callbacks', { blob: big });
    expect(stored.inline).toBeNull();
    expect(stored.key).toMatch(/^callbacks\//);
    expect(stored.sizeBytes).toBeGreaterThan(MAX_INLINE_BODY_BYTES);
    const roundTripped = await storage.get(stored.key as string);
    expect(new TextDecoder().decode(roundTripped)).toBe(JSON.stringify({ blob: big }));
  });

  it('keeps a body of exactly 16 KB inline', async () => {
    const storage = await makeStorage();
    const stored = await storeBody(storage, 'events', 'a'.repeat(MAX_INLINE_BODY_BYTES));
    expect(stored.inline).not.toBeNull();
    expect(stored.key).toBeNull();
  });
});
