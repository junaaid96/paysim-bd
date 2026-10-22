// Encryption at rest for real-sandbox provider keys (AES-256-GCM).
// The key comes from PAYSIM_SECRETS_KEY (any high-entropy string; it is
// hashed to 32 bytes). Without it, real-sandbox mode cannot be enabled
// and stored ciphertext is treated as absent.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';

function keyFrom(secret: string | undefined): Buffer | null {
  const trimmed = secret?.trim();
  if (!trimmed) return null;
  return createHash('sha256').update(trimmed).digest();
}

export function secretsConfigured(secret = process.env['PAYSIM_SECRETS_KEY']): boolean {
  return keyFrom(secret) !== null;
}

export function encryptJson(
  value: Record<string, string>,
  secret = process.env['PAYSIM_SECRETS_KEY'],
): string {
  const key = keyFrom(secret);
  if (!key) throw new Error('PAYSIM_SECRETS_KEY is not configured');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(
    ':',
  );
}

export function decryptJson(
  blob: unknown,
  secret = process.env['PAYSIM_SECRETS_KEY'],
): Record<string, string> | null {
  const key = keyFrom(secret);
  if (!key || typeof blob !== 'string') return null;
  const [version, iv, tag, data] = blob.split(':');
  if (version !== VERSION || !iv || !tag || !data) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(plain) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return null;
  }
}

/** Masked hint for a secret value: at most the last 4 characters (fewer for short secrets). */
export function maskSecret(value: string): string {
  if (value.length >= 12) return `••••${value.slice(-4)}`;
  if (value.length >= 8) return `••••${value.slice(-2)}`;
  return '••••';
}

/** Stored shape of gateway_apps.sandbox. */
export interface StoredSandbox {
  mode?: 'simulator' | 'real';
  keys?: string;
  hints?: Record<string, string>;
  updatedAt?: string;
}
