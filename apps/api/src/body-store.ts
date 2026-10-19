// Bodies over MAX_INLINE_BODY_BYTES (16 KB) live in object storage with
// only the key stored in Postgres. Everything stored here is redacted first.

import { randomUUID } from 'node:crypto';

import { MAX_INLINE_BODY_BYTES, redactValue } from '@paysim/core';

import type { StorageAdapter } from './storage/index.js';

const encoder = new TextEncoder();

export interface StoredBody {
  /** Set when the (redacted) body fit inline; otherwise null. */
  inline: string | null;
  /** Object-storage key when the body exceeded the inline limit. */
  key: string | null;
  sizeBytes: number;
}

export async function storeBody(
  storage: StorageAdapter,
  keyPrefix: string,
  input: unknown,
  contentType = 'application/json',
): Promise<StoredBody> {
  const redacted = redactValue(input);
  const text = typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
  const bytes = encoder.encode(text);
  if (bytes.length <= MAX_INLINE_BODY_BYTES) {
    return { inline: text, key: null, sizeBytes: bytes.length };
  }
  const key = `${keyPrefix}/${randomUUID()}.json`;
  await storage.put(key, bytes, contentType);
  return { inline: null, key, sizeBytes: bytes.length };
}
