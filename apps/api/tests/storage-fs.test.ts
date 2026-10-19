import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { InvalidStorageKeyError, StorageNotFoundError } from '../src/storage/adapter.js';
import { FsStorageDriver } from '../src/storage/fs.js';

describe('FsStorageDriver', () => {
  let dirs: string[] = [];
  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    dirs = [];
  });

  async function makeDriver(): Promise<{ driver: FsStorageDriver; root: string }> {
    const root = await mkdtemp(join(tmpdir(), 'paysim-fs-'));
    dirs.push(root);
    return { driver: new FsStorageDriver(root), root };
  }

  it('round-trips objects in nested keys', async () => {
    const { driver } = await makeDriver();
    const body = new TextEncoder().encode(JSON.stringify({ ok: true }));
    const stored = await driver.put('a/b/c.json', body, 'application/json');
    expect(stored).toEqual({
      key: 'a/b/c.json',
      sizeBytes: body.byteLength,
      contentType: 'application/json',
    });
    // get() returns a Buffer (a Uint8Array); compare byte content, not class.
    expect(new Uint8Array(await driver.get('a/b/c.json'))).toEqual(body);
    expect(await driver.head('a/b/c.json')).toEqual({
      key: 'a/b/c.json',
      sizeBytes: body.byteLength,
      contentType: 'application/json',
    });
  });

  it('clears stale content-type metadata when overwritten without one', async () => {
    const { driver } = await makeDriver();
    await driver.put('k', new Uint8Array([1]), 'text/plain');
    await driver.put('k', new Uint8Array([2]));
    expect(await driver.head('k')).toEqual({ key: 'k', sizeBytes: 1, contentType: undefined });
  });

  it('maps missing keys to StorageNotFoundError / null and deletes idempotently', async () => {
    const { driver } = await makeDriver();
    await expect(driver.get('missing')).rejects.toBeInstanceOf(StorageNotFoundError);
    expect(await driver.head('missing')).toBeNull();
    await expect(driver.delete('missing')).resolves.toBeUndefined();

    await driver.put('gone', new Uint8Array([1]));
    await driver.delete('gone');
    await expect(driver.get('gone')).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it('rejects unsafe keys without touching disk', async () => {
    const { driver, root } = await makeDriver();
    const unsafe = [
      '',
      '/absolute',
      '\\absolute',
      '..',
      '../escape',
      'a/../escape',
      'a/./b',
      'a//b',
      'back\\slash',
      'ctrl\u0000char',
      'x'.repeat(1025),
    ];
    for (const key of unsafe) {
      await expect(driver.put(key, new Uint8Array([1])), key).rejects.toBeInstanceOf(
        InvalidStorageKeyError,
      );
    }
    // Only the root dir itself exists — nothing escaped or was created.
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(root)).toEqual([]);
  });

  it('writes bytes verbatim', async () => {
    const { driver, root } = await makeDriver();
    const body = Uint8Array.from([0, 1, 2, 250, 255]);
    await driver.put('bin/blob', body);
    expect(await readFile(join(root, 'bin', 'blob'))).toEqual(Buffer.from(body));
  });
});
