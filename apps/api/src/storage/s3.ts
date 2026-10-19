import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';

import {
  assertSafeKey,
  StorageNotFoundError,
  type StorageAdapter,
  type StoredObject,
} from './adapter.js';

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ('name' in err && (err.name === 'NoSuchKey' || err.name === 'NotFound')) return true;
  if ('$metadata' in err) {
    const metadata = err.$metadata as { httpStatusCode?: unknown };
    if (metadata.httpStatusCode === 404) return true;
  }
  return false;
}

/** S3-compatible driver (Cloudflare R2 when hosted; any S3 endpoint works). */
export class S3StorageDriver implements StorageAdapter {
  readonly name = 's3' as const;

  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(client: S3Client, bucket: string) {
    this.client = client;
    this.bucket = bucket;
  }

  async put(key: string, body: Uint8Array, contentType?: string): Promise<StoredObject> {
    assertSafeKey(key);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
    return { key, sizeBytes: body.byteLength, contentType };
  }

  async get(key: string): Promise<Uint8Array> {
    assertSafeKey(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) {
        throw new Error(`S3 returned no body for key ${JSON.stringify(key)}`);
      }
      return await res.Body.transformToByteArray();
    } catch (err) {
      if (isNotFound(err)) throw new StorageNotFoundError(key);
      throw err;
    }
  }

  async head(key: string): Promise<StoredObject | null> {
    assertSafeKey(key);
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { key, sizeBytes: res.ContentLength ?? 0, contentType: res.ContentType };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
