// S3-compatible object storage behind one interface. Two drivers:
// `fs` (local default) and `s3` (Cloudflare R2 when hosted).

export interface StoredObject {
  key: string;
  sizeBytes: number;
  contentType?: string;
}

export interface StorageAdapter {
  readonly name: 'fs' | 's3';
  put(key: string, body: Uint8Array, contentType?: string): Promise<StoredObject>;
  get(key: string): Promise<Uint8Array>;
  /** Metadata probe. Returns null when the key does not exist. */
  head(key: string): Promise<StoredObject | null>;
  /** Delete is idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
}

export class StorageNotFoundError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`Object not found: ${key}`);
    this.name = 'StorageNotFoundError';
    this.key = key;
  }
}

export class InvalidStorageKeyError extends Error {
  readonly key: string;

  constructor(key: string, reason: string) {
    super(`Invalid storage key ${JSON.stringify(key)}: ${reason}`);
    this.name = 'InvalidStorageKeyError';
    this.key = key;
  }
}

const MAX_KEY_LENGTH = 1024;

/**
 * Reject keys that could escape the bucket/root: absolute paths, parent
 * traversal, backslashes, control characters, empty segments. Both drivers
 * (and the fs driver's resolve-and-contain check) enforce this.
 */
export function assertSafeKey(key: string): void {
  if (key.length === 0) {
    throw new InvalidStorageKeyError(key, 'key must not be empty');
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new InvalidStorageKeyError(key, `key must be at most ${MAX_KEY_LENGTH} chars`);
  }
  if (key.startsWith('/') || key.startsWith('\\')) {
    throw new InvalidStorageKeyError(key, 'key must be relative');
  }
  if (key.includes('\\')) {
    throw new InvalidStorageKeyError(key, 'backslashes are not allowed');
  }
  if (key.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new InvalidStorageKeyError(key, 'empty, "." and ".." segments are not allowed');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) {
    throw new InvalidStorageKeyError(key, 'control characters are not allowed');
  }
}
