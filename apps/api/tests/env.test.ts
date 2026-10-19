import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/env.js';

const DATABASE_URL = 'postgres://paysim:paysim@localhost:5432/paysim';

describe('loadEnv', () => {
  it('applies local-friendly defaults from a minimal source', () => {
    const env = loadEnv({ DATABASE_URL });
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3001);
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.DB_POOL_MAX).toBe(5);
    expect(env.STORAGE_DRIVER).toBe('fs');
    expect(env.STORAGE_FS_DIR).toBe('./data/blobs');
    expect(env.S3_REGION).toBe('auto');
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
  });

  it('defaults the SSRF guard to secure (private targets blocked)', () => {
    expect(loadEnv({ DATABASE_URL }).ALLOW_PRIVATE_CALLBACK_TARGETS).toBe(false);
    expect(
      loadEnv({ DATABASE_URL, ALLOW_PRIVATE_CALLBACK_TARGETS: 'true' })
        .ALLOW_PRIVATE_CALLBACK_TARGETS,
    ).toBe(true);
    expect(
      loadEnv({ DATABASE_URL, ALLOW_PRIVATE_CALLBACK_TARGETS: 'false' })
        .ALLOW_PRIVATE_CALLBACK_TARGETS,
    ).toBe(false);
  });

  it('coerces numeric strings', () => {
    expect(loadEnv({ DATABASE_URL, PORT: '4000' }).PORT).toBe(4000);
    expect(() => loadEnv({ DATABASE_URL, PORT: 'not-a-port' })).toThrow(/PORT/);
  });

  it('rejects a missing or non-postgres DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
    expect(() => loadEnv({ DATABASE_URL: 'mysql://localhost/db' })).toThrow(/DATABASE_URL/);
  });

  it('accepts a Neon-style pooled string with sslmode=require', () => {
    const url = 'postgres://user:pass@ep-xyz.pooler.neon.tech/db?sslmode=require';
    expect(loadEnv({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it('requires S3 settings when STORAGE_DRIVER=s3', () => {
    expect(() => loadEnv({ DATABASE_URL, STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
    const env = loadEnv({
      DATABASE_URL,
      STORAGE_DRIVER: 's3',
      S3_ENDPOINT: 'https://x.r2.cloudflarestorage.com',
      S3_BUCKET: 'paysim',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'secret',
    });
    expect(env.STORAGE_DRIVER).toBe('s3');
  });

  it('treats empty-string S3 values as missing', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL,
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: 'https://x.r2.cloudflarestorage.com',
        S3_BUCKET: '',
        S3_ACCESS_KEY_ID: 'id',
        S3_SECRET_ACCESS_KEY: 'secret',
      }),
    ).toThrow(/S3_BUCKET/);
  });

  it('ignores unknown keys', () => {
    expect(loadEnv({ DATABASE_URL, SOME_FUTURE_VAR: 'x' }).PORT).toBe(3001);
  });
});
