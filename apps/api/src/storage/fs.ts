import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import {
  assertSafeKey,
  InvalidStorageKeyError,
  StorageNotFoundError,
  type StorageAdapter,
  type StoredObject,
} from './adapter.js';

interface FsMeta {
  contentType?: string;
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

/** Local-directory driver. Local mode only — never used when hosted. */
export class FsStorageDriver implements StorageAdapter {
  readonly name = 'fs' as const;

  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  private pathFor(key: string): string {
    assertSafeKey(key);
    const full = resolve(join(this.root, key));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new InvalidStorageKeyError(key, 'key escapes the storage root');
    }
    return full;
  }

  async put(key: string, body: Uint8Array, contentType?: string): Promise<StoredObject> {
    const full = this.pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
    if (contentType === undefined) {
      await rm(`${full}.meta.json`, { force: true });
    } else {
      const meta: FsMeta = { contentType };
      await writeFile(`${full}.meta.json`, JSON.stringify(meta));
    }
    return { key, sizeBytes: body.byteLength, contentType };
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      return await readFile(this.pathFor(key));
    } catch (err) {
      if (isEnoent(err)) throw new StorageNotFoundError(key);
      throw err;
    }
  }

  async head(key: string): Promise<StoredObject | null> {
    const full = this.pathFor(key);
    let sizeBytes: number;
    try {
      sizeBytes = (await stat(full)).size;
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
    let contentType: string | undefined;
    try {
      const meta = JSON.parse(await readFile(`${full}.meta.json`, 'utf8')) as FsMeta;
      contentType = meta.contentType;
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    return { key, sizeBytes, contentType };
  }

  async delete(key: string): Promise<void> {
    const full = this.pathFor(key);
    await rm(full, { force: true });
    await rm(`${full}.meta.json`, { force: true });
  }
}
