import { z } from 'zod';

// Empty-string env values (e.g. `CORS_ORIGIN=` from a .env file) mean "unset".
function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .refine(
        (v) => v.startsWith('postgres://') || v.startsWith('postgresql://'),
        'DATABASE_URL must be a postgres:// or postgresql:// URL (Neon: pooled string with ?sslmode=require)',
      ),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),

    STORAGE_DRIVER: z.enum(['fs', 's3']).default('fs'),
    STORAGE_FS_DIR: z.string().default('./data/blobs'),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().default('auto'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: z.stringbool().default(true),

    // Secure by default: only local mode opts into private callback targets.
    ALLOW_PRIVATE_CALLBACK_TARGETS: z.stringbool().default(false),

    CORS_ORIGIN: z.string().optional(),
    WEB_DIST_DIR: z.string().optional(),
  })
  .refine((env) => env.STORAGE_DRIVER !== 's3' || nonEmpty(env.S3_ENDPOINT) !== undefined, {
    message: 'S3_ENDPOINT is required when STORAGE_DRIVER=s3',
    path: ['S3_ENDPOINT'],
  })
  .refine((env) => env.STORAGE_DRIVER !== 's3' || nonEmpty(env.S3_BUCKET) !== undefined, {
    message: 'S3_BUCKET is required when STORAGE_DRIVER=s3',
    path: ['S3_BUCKET'],
  })
  .refine((env) => env.STORAGE_DRIVER !== 's3' || nonEmpty(env.S3_ACCESS_KEY_ID) !== undefined, {
    message: 'S3_ACCESS_KEY_ID is required when STORAGE_DRIVER=s3',
    path: ['S3_ACCESS_KEY_ID'],
  })
  .refine(
    (env) => env.STORAGE_DRIVER !== 's3' || nonEmpty(env.S3_SECRET_ACCESS_KEY) !== undefined,
    {
      message: 'S3_SECRET_ACCESS_KEY is required when STORAGE_DRIVER=s3',
      path: ['S3_SECRET_ACCESS_KEY'],
    },
  );

export type Env = z.infer<typeof envSchema>;

/** Parse and validate the process environment. Throws a readable Error. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }
  return parsed.data;
}

export { nonEmpty };
