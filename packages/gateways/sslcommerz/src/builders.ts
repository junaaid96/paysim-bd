// Pure response/payload builders. Shapes follow spec/v1.json; anything the
// official sources leave unstated is marked there, not here.

import { randomBytes } from 'node:crypto';

import { VERIFY_KEY, computeVerifySign } from './verify.js';

// ---------------------------------------------------------------------------
// ID generation (shape-by-example; see spec notes)
// ---------------------------------------------------------------------------

/** 32-char uppercase hex, like the doc example sessionkey. */
export function generateSessionKey(): string {
  return randomBytes(16).toString('hex').toUpperCase();
}

const REF_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** 13 digits + 13 alphanumerics, like the doc val_id/bank_tran_id examples. */
export function generateRefId(nowMs = Date.now()): string {
  const bytes = randomBytes(13);
  let suffix = '';
  for (const byte of bytes) {
    suffix += REF_ALPHABET[byte % REF_ALPHABET.length];
  }
  return `${String(nowMs).padStart(13, '0')}${suffix}`;
}

/** Minor units -> "103.00" style decimal string. */
export function formatAmount(amountMinor: number): string {
  return (amountMinor / 100).toFixed(2);
}

// ---------------------------------------------------------------------------
// Simulated card fixture (mock page has no card entry; values are fixtures)
// ---------------------------------------------------------------------------

export interface CardFixture {
  cardType: string;
  cardNo: string;
  cardIssuer: string;
  cardBrand: string;
  cardIssuerCountry: string;
  cardIssuerCountryCode: string;
}

export const DEFAULT_CARD_FIXTURE: CardFixture = {
  cardType: 'VISA-TestBank',
  cardNo: '411111XXXXXX1111',
  cardIssuer: 'Test Bank',
  cardBrand: 'VISA',
  cardIssuerCountry: 'Bangladesh',
  cardIssuerCountryCode: 'BD',
};

// ---------------------------------------------------------------------------
// Init response
// ---------------------------------------------------------------------------

/** Gateway category codes echoed from the doc init example. */
export const GW_CATEGORIES: Record<string, string> = {
  visa: 'dbbl_visa,brac_visa,city_visa,ebl_visa,visacard',
  master: 'dbbl_master,brac_master,city_master,ebl_master,mastercard',
  amex: 'city_amex,amexcard',
  othercards: 'dbbl_nexus,qcash,fastcash',
  internetbanking: 'city,bankasia,ibbl,mtbl',
  mobilebanking: 'dbblmobilebanking,bkash,abbank,ibbl',
};

const DESC_CHANNELS: Array<{ name: string; type: string; gw: string }> = [
  { name: 'VISA', type: 'visa', gw: 'visacard' },
  { name: 'MASTER', type: 'master', gw: 'mastercard' },
  { name: 'AMEX', type: 'amex', gw: 'amexcard' },
  { name: 'NEXUS', type: 'othercards', gw: 'dbbl_nexus' },
  { name: 'QCash', type: 'othercards', gw: 'qcash' },
  { name: 'BKash', type: 'mobilebanking', gw: 'bkash' },
  { name: 'DBBL Mobile Banking', type: 'mobilebanking', gw: 'dbblmobilebanking' },
  { name: 'IBBL', type: 'internetbanking', gw: 'ibbl' },
  { name: 'Citytouch', type: 'internetbanking', gw: 'city' },
  { name: 'Bank Asia', type: 'internetbanking', gw: 'bankasia' },
];

export interface InitResponseInput {
  sessionkey: string;
  gatewayPageUrl: string;
}

export function buildInitResponse(input: InitResponseInput): Record<string, unknown> {
  return {
    status: 'SUCCESS',
    failedreason: '',
    sessionkey: input.sessionkey,
    gw: { ...GW_CATEGORIES },
    redirectGatewayURL: input.gatewayPageUrl,
    directPaymentURLBank: '',
    directPaymentURLCard: '',
    directPaymentURL: '',
    redirectGatewayURLFailed: '',
    GatewayPageURL: input.gatewayPageUrl,
    storeBanner: '',
    storeLogo: '',
    desc: DESC_CHANNELS.map((channel) => ({
      name: channel.name,
      type: channel.type,
      logo: '',
      gw: channel.gw,
      r_flag: '1',
      redirectGatewayURL: input.gatewayPageUrl,
    })),
    is_direct_pay_enable: '0',
  };
}

export function buildInitFailure(failedreason: string): Record<string, unknown> {
  return { status: 'FAILED', failedreason };
}

// ---------------------------------------------------------------------------
// IPN payload
// ---------------------------------------------------------------------------

export interface IpnInput {
  ipnStatus: 'VALID' | 'FAILED' | 'CANCELLED';
  tranId: string;
  valId: string;
  amountMinor: number;
  currencyType: string;
  storeId: string;
  storePasswd: string;
  bankTranId: string;
  tranDate: string;
  card: CardFixture;
  values: { a: string; b: string; c: string; d: string };
  /** Init customer/shipping echoes (docs-only). */
  echoes?: Record<string, string>;
}

export function buildIpnPayload(input: IpnInput): Record<string, string> {
  const amount = formatAmount(input.amountMinor);
  const payload: Record<string, string> = {
    status: input.ipnStatus,
    tran_date: input.tranDate,
    tran_id: input.tranId,
    val_id: input.ipnStatus === 'VALID' ? input.valId : '',
    amount,
    store_amount: amount,
    card_type: input.card.cardType,
    card_no: input.card.cardNo,
    currency: 'BDT',
    bank_tran_id: input.bankTranId,
    card_issuer: input.card.cardIssuer,
    card_brand: input.card.cardBrand,
    card_issuer_country: input.card.cardIssuerCountry,
    card_issuer_country_code: input.card.cardIssuerCountryCode,
    currency_type: input.currencyType,
    currency_amount: amount,
    currency_rate: '1.0000',
    base_fair: '0.00',
    store_id: input.storeId,
    value_a: input.values.a,
    value_b: input.values.b,
    value_c: input.values.c,
    value_d: input.values.d,
    risk_level: '0',
    risk_title: 'Safe',
  };
  if (input.echoes) {
    for (const [key, value] of Object.entries(input.echoes)) {
      payload[key] = value;
    }
  }
  payload['verify_key'] = VERIFY_KEY;
  payload['verify_sign'] = computeVerifySign(payload, VERIFY_KEY, input.storePasswd);
  return payload;
}

// ---------------------------------------------------------------------------
// Validation response
// ---------------------------------------------------------------------------

export interface ValidationInput extends Omit<IpnInput, 'ipnStatus' | 'echoes'> {
  validationStatus: 'VALID' | 'VALIDATED';
  validatedOn: string;
}

export function buildValidationResponse(input: ValidationInput): Record<string, string> {
  const amount = formatAmount(input.amountMinor);
  return {
    status: input.validationStatus,
    tran_date: input.tranDate,
    tran_id: input.tranId,
    val_id: input.valId,
    amount,
    store_amount: amount,
    currency: 'BDT',
    bank_tran_id: input.bankTranId,
    card_type: input.card.cardType,
    card_no: input.card.cardNo,
    card_issuer: input.card.cardIssuer,
    card_brand: input.card.cardBrand,
    card_issuer_country: input.card.cardIssuerCountry,
    card_issuer_country_code: input.card.cardIssuerCountryCode,
    currency_type: input.currencyType,
    currency_amount: amount,
    currency_rate: '1.0000',
    base_fair: '0.00',
    value_a: input.values.a,
    value_b: input.values.b,
    value_c: input.values.c,
    value_d: input.values.d,
    emi_instalment: '0',
    emi_amount: '0.00',
    emi_description: '',
    emi_issuer: '',
    account_details: '',
    risk_title: 'Safe',
    risk_level: '0',
    APIConnect: 'DONE',
    validated_on: input.validatedOn,
    gw_version: '',
  };
}

// ---------------------------------------------------------------------------
// Browser callback payloads (auto-POSTed by the mock page's return form)
// ---------------------------------------------------------------------------

export type CallbackKind = 'success' | 'fail' | 'cancel';

export interface CallbackInput {
  kind: CallbackKind;
  tranId: string;
  valId: string;
  amountMinor: number;
  storeId: string;
  storePasswd: string;
  bankTranId: string;
  tranDate: string;
  card: CardFixture;
  errorText: string;
}

export function buildCallbackPayload(input: CallbackInput): Record<string, string> {
  const amount = formatAmount(input.amountMinor);
  const status =
    input.kind === 'success' ? 'VALID' : input.kind === 'fail' ? 'FAILED' : 'CANCELLED';
  const payload: Record<string, string> = {
    tran_id: input.tranId,
    status,
    amount,
    currency: 'BDT',
    tran_date: input.tranDate,
    card_issuer: input.card.cardIssuer,
    bank_tran_id: input.bankTranId,
  };
  if (input.kind === 'success') {
    payload['val_id'] = input.valId;
  } else {
    payload['error'] = input.errorText;
  }
  // verify pair computed over the fields present (same algorithm as IPN).
  const verifyKey = Object.keys(payload).join(',');
  payload['verify_key'] = verifyKey;
  payload['verify_sign'] = computeVerifySign(payload, verifyKey, input.storePasswd);
  return payload;
}
