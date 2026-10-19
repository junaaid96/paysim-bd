import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it } from 'vitest';

import { InvalidStorageKeyError, StorageNotFoundError } from '../src/storage/adapter.js';
import { S3StorageDriver } from '../src/storage/s3.js';

/** In-memory stand-in for S3Client: records real SDK command objects. */
class FakeS3Client {
  readonly store = new Map<string, { body: Uint8Array; contentType?: string }>();
  readonly sent: string[] = [];

  async send(command: unknown): Promise<Record<string, unknown>> {
    if (command instanceof PutObjectCommand) {
      this.sent.push('Put');
      const key = command.input.Key as string;
      this.store.set(key, {
        body: command.input.Body as Uint8Array,
        contentType: command.input.ContentType,
      });
      return {};
    }
    if (command instanceof GetObjectCommand) {
      this.sent.push('Get');
      const obj = this.store.get(command.input.Key as string);
      if (!obj) {
        const err = new Error('The specified key does not exist.') as Error & { name: string };
        err.name = 'NoSuchKey';
        throw err;
      }
      return { Body: { transformToByteArray: async () => obj.body } };
    }
    if (command instanceof HeadObjectCommand) {
      this.sent.push('Head');
      const obj = this.store.get(command.input.Key as string);
      if (!obj) {
        const err = new Error('Not Found') as Error & {
          $metadata: { httpStatusCode: number };
        };
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return { ContentLength: obj.body.byteLength, ContentType: obj.contentType };
    }
    if (command instanceof DeleteObjectCommand) {
      this.sent.push('Delete');
      this.store.delete(command.input.Key as string);
      return {};
    }
    throw new Error(`unexpected command: ${String(command)}`);
  }
}

describe('S3StorageDriver', () => {
  let fake: FakeS3Client;
  let driver: S3StorageDriver;

  beforeEach(() => {
    fake = new FakeS3Client();
    driver = new S3StorageDriver(fake as unknown as S3Client, 'test-bucket');
  });

  it('round-trips objects with real SDK commands', async () => {
    const body = new TextEncoder().encode('hello s3');
    expect(await driver.put('a/b.txt', body, 'text/plain')).toEqual({
      key: 'a/b.txt',
      sizeBytes: body.byteLength,
      contentType: 'text/plain',
    });
    expect(await driver.get('a/b.txt')).toEqual(body);
    expect(await driver.head('a/b.txt')).toEqual({
      key: 'a/b.txt',
      sizeBytes: body.byteLength,
      contentType: 'text/plain',
    });
    await driver.delete('a/b.txt');
    expect(fake.sent).toEqual(['Put', 'Get', 'Head', 'Delete']);
  });

  it('maps S3 404s (name- and metadata-shaped) to not-found', async () => {
    await expect(driver.get('missing')).rejects.toBeInstanceOf(StorageNotFoundError);
    expect(await driver.head('missing')).toBeNull();
  });

  it('lets non-404 errors propagate untouched', async () => {
    const boom = Object.assign(new Error('boom'), { $metadata: { httpStatusCode: 500 } });
    fake.send = async () => {
      throw boom;
    };
    await expect(driver.get('k')).rejects.toBe(boom);
  });

  it('rejects unsafe keys before sending anything', async () => {
    await expect(driver.put('../x', new Uint8Array([1]))).rejects.toBeInstanceOf(
      InvalidStorageKeyError,
    );
    expect(fake.sent).toEqual([]);
  });
});
