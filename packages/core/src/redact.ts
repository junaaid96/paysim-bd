// Secret redaction for anything persisted (events, deliveries, recordings)
// or logged. Key-name based: any object key or header name that looks like
// a credential has its value replaced. Unknown shapes are redacted by key,
// never passed through on the basis of an allowlist.

import { REDACTED } from './constants.js';

const SECRET_KEY_PATTERN =
  /(passw(or)?d|passwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret|authorization|auth|cookie|set-cookie|card[_-]?num(ber)?|cvv|cvc|pin|otp|signature|sign|hash|store[_-]?passwd|sensitive[_-]?data)/i;

const BEARER_PATTERN = /^(bearer|basic)\s+.+/i;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * Deep-clone `value`, replacing anything stored under a secret-looking key
 * with `[REDACTED]`. Primitives that look like `Bearer ...` / `Basic ...`
 * tokens are redacted too. Circular structures are replaced with
 * `[Circular]` instead of throwing.
 */
export function redactValue<T>(value: T): T {
  return redactInner(value, new Set()) as T;
}

function redactInner(value: unknown, seen: Set<object>): unknown {
  if (typeof value === 'string') {
    return BEARER_PATTERN.test(value.trim()) ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map((item) => redactInner(item, seen));
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = isSecretKey(key) ? REDACTED : redactInner(entry, seen);
    }
    return out;
  }
  return value;
}

/** Redact secret-looking headers (names matched case-insensitively). */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, val] of Object.entries(headers)) {
    out[name] = isSecretKey(name) || BEARER_PATTERN.test(val.trim()) ? REDACTED : val;
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes without splitting a
 * code point. Appends `…` when truncated.
 */
export function truncateUtf8(input: string, maxBytes: number): string {
  const bytes = encoder.encode(input);
  if (bytes.length <= maxBytes) return input;
  let end = maxBytes;
  // Back off over UTF-8 continuation bytes (10xxxxxx).
  while (end > 0 && isContinuationByte(bytes[end])) end -= 1;
  return `${decoder.decode(bytes.subarray(0, end))}…`;
}

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0b1100_0000) === 0b1000_0000;
}

/** Byte length of a string, measured as UTF-8. */
export function utf8ByteLength(input: string): number {
  return encoder.encode(input).length;
}
