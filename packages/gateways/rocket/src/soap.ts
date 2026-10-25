// Minimal SOAP 1.1 helpers for the DBBL e-commerce web service.
// Source: the live WSDL/XSD at
//   https://ecomtest.dutchbanglabank.com/ecomws/dbblecomtxn?wsdl  (and ?xsd=1)
// JAX-WS service, target namespace http://ecom.dbbl/, document/literal,
// every operation returns one string element <return>.

export const DBBL_NS = 'http://ecom.dbbl/';
export const OPERATIONS = ['getransid', 'getresult', 'getresultrocket'] as const;
export type Operation = (typeof OPERATIONS)[number];

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

export function soapRequest(op: Operation, fields: Record<string, string>): string {
  const inner = Object.entries(fields)
    .map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body>' +
    `<ns2:${op} xmlns:ns2="${DBBL_NS}">${inner}</ns2:${op}>` +
    '</S:Body></S:Envelope>'
  );
}

export function soapResponse(op: string, value: string): string {
  return (
    "<?xml version='1.0' encoding='UTF-8'?>" +
    '<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body>' +
    `<ns2:${op}Response xmlns:ns2="${DBBL_NS}"><return>${xmlEscape(value)}</return></ns2:${op}Response>` +
    '</S:Body></S:Envelope>'
  );
}

export function soapFault(message: string): string {
  return (
    "<?xml version='1.0' encoding='UTF-8'?>" +
    '<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><S:Fault>' +
    `<faultcode>S:Client</faultcode><faultstring>${xmlEscape(message)}</faultstring>` +
    '</S:Fault></S:Body></S:Envelope>'
  );
}

/** Parse a request envelope: operation name + its child text fields. */
export function parseSoapRequest(
  xml: string,
): { op: string; fields: Record<string, string> } | null {
  const body = /<(?:[\w-]+:)?Body\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Body>/i.exec(xml)?.[1];
  if (!body) return null;
  const opMatch = /<(?:([\w-]+):)?([A-Za-z]\w*)\b[^>]*>([\s\S]*)<\/(?:\1:)?\2>/.exec(body.trim());
  if (!opMatch) return null;
  const fields: Record<string, string> = {};
  const re = /<(?:[\w-]+:)?(\w+)\s*(?:\/>|>([^<]*)<\/(?:[\w-]+:)?\1>)/g;
  for (let m = re.exec(opMatch[3] ?? ''); m; m = re.exec(opMatch[3] ?? '')) {
    fields[m[1]!] = xmlUnescape(m[2] ?? '').trim();
  }
  return { op: opMatch[2]!, fields };
}

/** Extract <return> text from a response envelope (or null on fault). */
export function parseSoapReturn(xml: string): string | null {
  const m = /<return>([\s\S]*?)<\/return>/.exec(xml);
  return m ? xmlUnescape(m[1]!) : null;
}

/**
 * DBBL result strings are "KEY: value" lines (legacy jar output, see
 * https://github.com/fattah/banglapay api/dbbl_lib.php). The live service
 * also answers "RESULT>Invalid Transaction ID" (observed), so ">" is
 * accepted as a separator too.
 */
export function parseResultLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*[:>]\s*(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}
