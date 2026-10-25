// Optional real-sandbox mode for Rocket (Dutch-Bangla Bank e-commerce).
// Active only when a store saves DBBL merchant credentials; otherwise the
// simulator runs.
//
// Sources:
//   - WSDL/XSD (live, public): https://ecomtest.dutchbanglabank.com/ecomws/dbblecomtxn?wsdl
//     operations getransid(userid,pwd,amount,cardtype,txnrefnum,clientip),
//     getresult / getresultrocket(userid,pwd,transid,clientip); each returns <return> string.
//   - Customer redirect + result format: https://github.com/fattah/banglapay
//     (api/dbbl_lib.php, dbblcallback.php): ClientHandler?card_type=X&trans_id=…,
//     amount in paisa (amount*100), "TRANSACTION_ID: …" / "RESULT: OK" lines.
// Uncertain: the Rocket cardtype code (DBBL assigns it), whether SOAP
// getransid wants paisa (the legacy jar did), and the exact difference
// between getresult and getresultrocket. Bad credentials answer
// "Wrong Merchant ID" (observed). DBBL documents no refund API and no IPN.

import { z } from 'zod';

import type {
  AppRecord,
  CredentialCheck,
  SandboxSupport,
  SettleRefundResult,
  TxnRecord,
} from '@paysim/core';

import { parseResultLines, parseSoapReturn, soapRequest, type Operation } from './soap.js';

export const DBBL_TEST_BASE = 'https://ecomtest.dutchbanglabank.com';
const TIMEOUT_MS = 20_000;

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
/** Test hook: swap the HTTP client (mocked provider responses). */
export function setRocketFetch(next: Fetch | null): void {
  fetchImpl = next ?? ((...args) => fetch(...args));
}

const httpsHost = (v: string): boolean => v === '' || /^https:\/\/[^\s/]+$/.test(v);

const KeysSchema = z.object({
  userid: z.string().trim().min(1).max(64),
  pwd: z.string().trim().min(1).max(256),
  cardtype: z.string().trim().min(1).max(8),
  base_url: z
    .string()
    .trim()
    .max(200)
    .optional()
    .default('')
    .refine(httpsHost, 'must be https://host (no path)'),
  client_ip: z.string().trim().max(45).optional().default(''),
});
export type RocketKeys = z.output<typeof KeysSchema>;

export function realKeys(app: AppRecord | null): RocketKeys | null {
  const keys = app?.sandbox?.mode === 'real' ? app.sandbox.keys : null;
  if (!keys) return null;
  const parsed = KeysSchema.safeParse(keys);
  return parsed.success ? parsed.data : null;
}

export function baseOf(keys: Pick<RocketKeys, 'base_url'>): string {
  return keys.base_url || DBBL_TEST_BASE;
}

export async function soapCall(
  keys: Pick<RocketKeys, 'base_url'>,
  op: Operation,
  fields: Record<string, string>,
): Promise<string> {
  const res = await fetchImpl(`${baseOf(keys)}/ecomws/dbblecomtxn`, {
    method: 'POST',
    headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: '""' },
    body: soapRequest(op, fields),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  const value = parseSoapReturn(text);
  if (value === null) {
    const fault = /<faultstring>([\s\S]*?)<\/faultstring>/.exec(text)?.[1];
    throw new Error(`DBBL ${op}: ${fault ?? `HTTP ${res.status}`}`);
  }
  return value;
}

export async function realInit(
  keys: RocketKeys,
  input: { amountPaisa: string; txnrefnum: string; clientip: string },
): Promise<{ ok: true; transId: string; raw: string } | { ok: false; reason: string }> {
  try {
    const raw = await soapCall(keys, 'getransid', {
      userid: keys.userid,
      pwd: keys.pwd,
      amount: input.amountPaisa,
      cardtype: keys.cardtype,
      txnrefnum: input.txnrefnum,
      clientip: keys.client_ip || input.clientip,
    });
    const transId = parseResultLines(raw)['TRANSACTION_ID'] ?? '';
    if (!transId) return { ok: false, reason: raw.trim().slice(0, 200) || 'empty reply' };
    return { ok: true, transId, raw };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function realResult(
  keys: RocketKeys,
  op: 'getresult' | 'getresultrocket',
  transId: string,
  clientip: string,
): Promise<string> {
  return soapCall(keys, op, {
    userid: keys.userid,
    pwd: keys.pwd,
    transid: transId,
    clientip: keys.client_ip || clientip,
  });
}

/** Map a DBBL result string to a local outcome; null = still pending. */
export function outcomeOf(raw: string): 'success' | 'fail' | 'cancel' | null {
  const r = parseResultLines(raw);
  const result = (r['RESULT'] ?? '').toUpperCase();
  if (result === 'OK' && (r['RESULT_CODE'] ?? '000') === '000') return 'success';
  if (result === 'TIMEOUT' || (r['RESULT_PS'] ?? '').toUpperCase() === 'CANCELLED') return 'cancel';
  if (result === 'FAILED' || result === 'DECLINED' || result === 'REVERSED') return 'fail';
  return null;
}

export function checkoutUrl(keys: RocketKeys, transId: string): string {
  return `${baseOf(keys)}/ecomm2/ClientHandler?card_type=${encodeURIComponent(keys.cardtype)}&trans_id=${encodeURIComponent(transId)}`;
}

export async function settleRealRefund(_txn: TxnRecord): Promise<SettleRefundResult> {
  return {
    ok: false,
    failureReason:
      'DBBL documents no refund API for Rocket e-commerce; refund in the DBBL merchant panel. (Simulator payments refund from the dashboard.)',
  };
}

export const rocketSandbox: SandboxSupport = {
  status: 'available',
  note: 'Needs merchant credentials from DBBL (Dutch-Bangla Bank): e-commerce user ID, password and the Rocket card type code. Uses DBBL’s public SOAP service (ecomtest host by default). No refund API or IPN is documented. Without saved keys Rocket stays on the simulator.',
  docsUrl: 'https://ecomtest.dutchbanglabank.com/ecomws/dbblecomtxn?wsdl',
  signupUrl: 'https://www.dutchbanglabank.com/rocket/rocket.html',
  fields: [
    { name: 'userid', label: 'DBBL merchant user ID', secret: false },
    { name: 'pwd', label: 'DBBL merchant password', secret: true },
    { name: 'cardtype', label: 'Card type code for Rocket (from DBBL)', secret: false },
    { name: 'base_url', label: `Base URL (optional, default ${DBBL_TEST_BASE})`, secret: false },
    { name: 'client_ip', label: 'Client IP sent to DBBL (optional)', secret: false },
  ],
  validateKeys(input: unknown): CredentialCheck {
    const parsed = KeysSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      };
    }
    return { ok: true, value: { ...parsed.data } };
  },
  // getresult checks transid before credentials (observed), so the only
  // credential probe is getransid. It opens one unpaid 1-taka test session.
  async testConnection(_ctx, _app, keys) {
    const checked = rocketSandbox.validateKeys(keys);
    if (!checked.ok) return { ok: false, message: checked.issues.join('; '), offline: true };
    const k = checked.value as RocketKeys;
    const res = await realInit(k, {
      amountPaisa: '100',
      txnrefnum: `PSTEST${Date.now()}`,
      clientip: '127.0.0.1',
    });
    return res.ok
      ? {
          ok: true,
          message: `DBBL getransid accepted these credentials (${baseOf(k)}); an unpaid test session was opened.`,
        }
      : { ok: false, message: `DBBL: ${res.reason}` };
  },
  settleRefund: (_ctx, txn) => settleRealRefund(txn),
};
