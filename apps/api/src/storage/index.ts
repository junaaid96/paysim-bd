import { S3Client } from '@aws-sdk/client-s3';

import { nonEmpty, type Env } from '../env.js';
import type { StorageAdapter } from './adapter.js';
import { FsStorageDriver } from './fs.js';
import { S3StorageDriver } from './s3.js';

export type { StorageAdapter, StoredObject } from './adapter.js';
export { InvalidStorageKeyError, StorageNotFoundError } from './adapter.js';

export interface CreateStorageOptions {
  /** Injected by tests to avoid constructing a real S3 client. */
  s3Client?: S3Client;
}

/**
 * Build the configured driver. Refuses `fs` in production: the hosted
 * filesystem is ephemeral, so hosted mode must use the `s3` driver.
 */
export function createStorageFromEnv(env: Env, options: CreateStorageOptions = {}): StorageAdapter {
  if (env.STORAGE_DRIVER === 'fs') {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'STORAGE_DRIVER=fs is not allowed with NODE_ENV=production: the hosted ' +
          'filesystem is ephemeral. Use STORAGE_DRIVER=s3.',
      );
    }
    return new FsStorageDriver(env.STORAGE_FS_DIR);
  }
  const endpoint = nonEmpty(env.S3_ENDPOINT);
  const bucket = nonEmpty(env.S3_BUCKET);
  const accessKeyId = nonEmpty(env.S3_ACCESS_KEY_ID);
  const secretAccessKey = nonEmpty(env.S3_SECRET_ACCESS_KEY);
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'STORAGE_DRIVER=s3 requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY',
    );
  }
  const client =
    options.s3Client ??
    new S3Client({
      endpoint,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId, secretAccessKey },
    });
  return new S3StorageDriver(client, bucket);
}
