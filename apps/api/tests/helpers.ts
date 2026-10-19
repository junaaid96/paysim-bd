import type { Env } from '../src/env.js';

/** Full valid Env for tests; override individual fields per case. */
export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3001,
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://paysim:paysim@localhost:5432/paysim',
    DB_POOL_MAX: 5,
    STORAGE_DRIVER: 'fs',
    STORAGE_FS_DIR: './data/blobs',
    S3_ENDPOINT: undefined,
    S3_REGION: 'auto',
    S3_BUCKET: undefined,
    S3_ACCESS_KEY_ID: undefined,
    S3_SECRET_ACCESS_KEY: undefined,
    S3_FORCE_PATH_STYLE: true,
    ALLOW_PRIVATE_CALLBACK_TARGETS: true,
    CORS_ORIGIN: undefined,
    WEB_DIST_DIR: undefined,
    SIM_BASE_URL: undefined,
    ...overrides,
  };
}
