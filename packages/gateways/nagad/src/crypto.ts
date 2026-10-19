// Mutual RSA with fake keys (community flow: PKCS1v15 encrypt, PKCS1v15 +
// SHA256 signatures, base64 transport). The simulator plays "Nagad" with
// the published fixture keypair: it decrypts requests, verifies merchant
// signatures, encrypts responses for the merchant key, and signs them.
// Fake keys prove message SHAPE, never identity.

import {
  constants,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

const PKCS1_V15 = constants.RSA_PKCS1_PADDING;

export class NagadCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NagadCryptoError';
  }
}

/** Normalize raw-base64 and PEM key inputs (community clients send both). */
export function normalizePublicKeyPem(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes('BEGIN')) return trimmed;
  const body = trimmed.replace(/\s+/g, '').replace(/.{64}/g, '$&\n').trim();
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
}

export function normalizePrivateKeyPem(input: string, pkcs8: boolean): string {
  const trimmed = input.trim();
  if (trimmed.includes('BEGIN')) return trimmed;
  const body = trimmed.replace(/\s+/g, '').replace(/.{64}/g, '$&\n').trim();
  const label = pkcs8 ? 'PRIVATE KEY' : 'RSA PRIVATE KEY';
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}

/** True when the value parses as an RSA public key (credential check). */
export function isParsableRsaPublicKey(input: string): boolean {
  try {
    const key = createPublicKey(normalizePublicKeyPem(input));
    return key.asymmetricKeyType === 'rsa';
  } catch {
    return false;
  }
}

/** Base64 RSAES-PKCS1-v1_5 decrypt with a PEM private key. */
export function rsaDecrypt(nagadPrivateKeyPem: string, payloadB64: string): string {
  let key: KeyObject;
  try {
    key = createPrivateKey(nagadPrivateKeyPem);
  } catch {
    throw new NagadCryptoError('Simulator Nagad private key is unloadable (fixture corrupt).');
  }
  // Node's base64 decoder never throws and OpenSSL 3.x may "decrypt" short
  // garbage to garbage bytes instead of erroring, so validate strictly first.
  const compact = payloadB64.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new NagadCryptoError('sensitiveData is not valid base64.');
  }
  const bytes = Buffer.from(compact, 'base64');
  const modulusBits = key.asymmetricKeyDetails?.modulusLength;
  if (typeof modulusBits === 'number' && bytes.length !== modulusBits / 8) {
    throw new NagadCryptoError(
      'Cannot decrypt sensitiveData with the simulator Nagad key. Encrypt with FAKE-nagad-sim-public.pem.',
    );
  }
  try {
    return privateDecrypt({ key, padding: PKCS1_V15 }, bytes).toString('utf8');
  } catch {
    throw new NagadCryptoError(
      'Cannot decrypt sensitiveData with the simulator Nagad key. Encrypt with FAKE-nagad-sim-public.pem.',
    );
  }
}

/** Base64 RSAES-PKCS1-v1_5 encrypt for a merchant public key. */
export function rsaEncrypt(merchantPublicKey: string, plaintext: string): string {
  let key: KeyObject;
  try {
    key = createPublicKey(normalizePublicKeyPem(merchantPublicKey));
  } catch {
    throw new NagadCryptoError('Merchant public key is unloadable.');
  }
  try {
    return publicEncrypt({ key, padding: PKCS1_V15 }, Buffer.from(plaintext, 'utf8')).toString(
      'base64',
    );
  } catch {
    throw new NagadCryptoError('Cannot encrypt for the merchant public key (too small?).');
  }
}

/** Base64 RSASSA-PKCS1-v1_5 + SHA256 sign with a PEM private key. */
export function rsaSign(privateKeyPem: string, plaintext: string): string {
  const key = createPrivateKey(privateKeyPem);
  return sign('sha256', Buffer.from(plaintext, 'utf8'), { key, padding: PKCS1_V15 }).toString(
    'base64',
  );
}

/** Verify a base64 signature over the exact plaintext string. */
export function rsaVerify(
  merchantPublicKey: string,
  plaintext: string,
  signatureB64: string,
): boolean {
  let key: KeyObject;
  try {
    key = createPublicKey(normalizePublicKeyPem(merchantPublicKey));
  } catch {
    return false;
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureB64, 'base64');
  } catch {
    return false;
  }
  try {
    return verify('sha256', Buffer.from(plaintext, 'utf8'), { key, padding: PKCS1_V15 }, signature);
  } catch {
    return false;
  }
}
