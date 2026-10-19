import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import { createStorageFromEnv } from '../src/storage/index.js';
import { makeEnv } from './helpers.js';

describe('createStorageFromEnv', () => {
  it('builds the fs driver by default', () => {
    const storage = createStorageFromEnv(makeEnv());
    expect(storage.name).toBe('fs');
  });

  it('refuses local-disk storage in production (ephemeral filesystem)', () => {
    expect(() =>
      createStorageFromEnv(makeEnv({ NODE_ENV: 'production', STORAGE_DRIVER: 'fs' })),
    ).toThrow(/ephemeral/);
  });

  it('builds the s3 driver with an injected client', async () => {
    const sent: unknown[] = [];
    const fakeClient = {
      send: async (cmd: unknown) => ({ sent: sent.push(cmd), Body: undefined }),
    };
    const storage = createStorageFromEnv(
      makeEnv({
        NODE_ENV: 'production',
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: 'https://x.r2.cloudflarestorage.com',
        S3_BUCKET: 'paysim',
        S3_ACCESS_KEY_ID: 'id',
        S3_SECRET_ACCESS_KEY: 'secret',
      }),
      { s3Client: fakeClient as unknown as S3Client },
    );
    expect(storage.name).toBe('s3');
    await storage.put('k', new Uint8Array([1]));
    expect(sent).toHaveLength(1);
  });

  it('rejects s3 without credentials even when called directly', () => {
    expect(() => createStorageFromEnv(makeEnv({ STORAGE_DRIVER: 's3' }))).toThrow(/S3_BUCKET/);
  });
});
