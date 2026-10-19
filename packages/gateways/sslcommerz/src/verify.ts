// verify_sign computation — a literal port of the official PHP lib's
// SSLCOMMERZ_hash_verify (SslCommerzNotification.php), except the final
// comparison is strict (===) instead of PHP's loose (==), which is safer
// against numeric-string juggling and behaviorally identical for real hashes.

import { createHash } from 'node:crypto';

export function md5Hex(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex');
}

/** Exact documented verify_key field set, in documented order. */
export const VERIFY_KEY_FIELDS = [
  'amount',
  'bank_tran_id',
  'base_fair',
  'card_brand',
  'card_issuer',
  'card_issuer_country',
  'card_issuer_country_code',
  'card_no',
  'card_type',
  'currency',
  'currency_amount',
  'currency_rate',
  'currency_type',
  'risk_level',
  'risk_title',
  'status',
  'store_amount',
  'store_id',
  'tran_date',
  'tran_id',
  'val_id',
  'value_a',
  'value_b',
  'value_c',
  'value_d',
] as const;

export const VERIFY_KEY = VERIFY_KEY_FIELDS.join(',');

export function computeVerifySign(
  payload: Record<string, string>,
  verifyKey: string,
  storePasswd: string,
): string {
  const data: Record<string, string> = {};
  for (const key of verifyKey.split(',')) {
    const value = payload[key];
    // Mirrors PHP isset(): missing keys are skipped, not hashed as empty.
    if (value !== undefined) {
      data[key] = value;
    }
  }
  data['store_passwd'] = md5Hex(storePasswd);
  // PHP ksort on string keys is byte-wise; identical to JS sort for ASCII.
  const hashString = Object.keys(data)
    .sort()
    .map((key) => `${key}=${data[key]}`)
    .join('&');
  return md5Hex(hashString);
}

export function verifySignature(
  payload: Record<string, string>,
  verifyKey: string,
  storePasswd: string,
  verifySign: string,
): boolean {
  return computeVerifySign(payload, verifyKey, storePasswd) === verifySign;
}
