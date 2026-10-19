// SSRF protection for outbound callbacks (hosted mode). When private
// targets are disallowed, every redirect hop's hostname is resolved and
// ALL resolved IPs must be public. Threat model: footgun prevention (a
// hosted simulator must never probe internal infra), not a hostile merchant
// — the merchant is the simulator's own user, so DNS-rebinding TOCTOU
// between check and connect is documented but out of scope.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface SafePostInput {
  url: string;
  body: string;
  headers?: Record<string, string>;
}

export interface SafePostOptions {
  allowPrivate: boolean;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBodyBytes?: number;
}

export type SafePostResult =
  | {
      ok: true;
      status: number;
      body: string;
      truncated: boolean;
      latencyMs: number;
      url: string;
    }
  | { ok: false; blocked: boolean; error: string; latencyMs: number };

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** True when a literal IP must never receive simulator callbacks. */
export function isDisallowedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const value = ipv4ToInt(ip);
    if (value === null) return true;
    const inCidr = (base: number, bits: number): boolean => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (value & mask) >>> 0 === base >>> 0;
    };
    return (
      inCidr(0x00000000, 8) || // 0.0.0.0/8 ("this network")
      inCidr(0x0a000000, 8) || // 10.0.0.0/8 (private)
      inCidr(0x7f000000, 8) || // 127.0.0.0/8 (loopback)
      inCidr(0xa9fe0000, 16) || // 169.254.0.0/16 (link-local)
      inCidr(0xac100000, 12) || // 172.16.0.0/12 (private)
      inCidr(0xc0a80000, 16) || // 192.168.0.0/16 (private)
      inCidr(0xe0000000, 4) || // 224.0.0.0/4 (multicast)
      inCidr(0xf0000000, 4) // 240.0.0.0/4 (reserved + broadcast)
    );
  }
  if (family === 6) {
    const groups = expandIPv6(ip);
    if (!groups) return true;
    const isZero = (from: number, to: number): boolean => {
      for (let i = from; i < to; i += 1) {
        if (groups[i] !== 0) return false;
      }
      return true;
    };
    if (isZero(0, 8)) return true; // :: (unspecified)
    if (isZero(0, 7) && groups[7] === 1) return true; // ::1 (loopback)
    // IPv4-mapped ::ffff:0:0/96: classify the embedded IPv4 address.
    if (isZero(0, 5) && groups[5] === 0xffff) {
      const hi = groups[6] ?? 0;
      const lo = groups[7] ?? 0;
      return isDisallowedIp(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    const first = groups[0] ?? 0;
    return (
      (first & 0xfe00) === 0xfc00 || // fc00::/7 (unique local)
      (first & 0xffc0) === 0xfe80 || // fe80::/10 (link-local)
      (first & 0xff00) === 0xff00 // ff00::/8 (multicast)
    );
  }
  return true;
}

/** Expand any valid IPv6 literal (incl. `::` and embedded IPv4) to 8 groups. */
function expandIPv6(ip: string): number[] | null {
  const lower = ip.toLowerCase();
  if (lower.includes('%')) return null; // zone id: cannot classify reliably
  const halves = lower.split('::');
  if (halves.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (side === '') return [];
    const out: number[] = [];
    for (const part of side.split(':')) {
      if (part.includes('.')) {
        const int = ipv4ToInt(part);
        if (int === null) return null;
        out.push((int >>> 16) & 0xffff, int & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
        out.push(Number.parseInt(part, 16));
      }
    }
    return out;
  };
  const head = parseSide(halves[0] ?? '');
  const tail = halves.length === 2 ? parseSide(halves[1] ?? '') : [];
  if (!head || !tail) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 && missing < 0) return null;
  return [...head, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail];
}

async function checkHost(hostname: string, allowPrivate: boolean): Promise<string | null> {
  if (allowPrivate) return null;
  const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  if (isIP(host) !== 0) {
    return isDisallowedIp(host) ? `refusing to call private IP ${host}` : null;
  }
  let resolved;
  try {
    resolved = await lookup(host, { all: true });
  } catch (err) {
    throw new Error(`DNS lookup failed for ${host}: ${err instanceof Error ? err.message : err}`, {
      cause: err,
    });
  }
  if (resolved.length === 0) {
    throw new Error(`DNS lookup returned no addresses for ${host}`);
  }
  for (const entry of resolved) {
    if (isDisallowedIp(entry.address)) {
      return `refusing to call ${host}: resolves to private IP ${entry.address}`;
    }
  }
  return null;
}

async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          const keep = value.byteLength - (total - maxBytes);
          if (keep > 0) chunks.push(value.subarray(0, keep));
          truncated = true;
          break;
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors; the body is already captured.
    }
  }
  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * POST a form body with redirect, size and timeout caps. `blocked: true`
 * means retrying is pointless (bad URL, private target, redirect loop);
 * `blocked: false` means the failure may be transient.
 */
export async function safePost(
  input: SafePostInput,
  options: SafePostOptions,
): Promise<SafePostResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxRedirects = options.maxRedirects ?? 3;
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;
  const fail = (blocked: boolean, error: string): SafePostResult => ({
    ok: false,
    blocked,
    error,
    latencyMs: Date.now() - started,
  });

  let current: URL;
  try {
    current = new URL(input.url);
  } catch {
    return fail(true, `invalid callback URL: ${input.url}`);
  }
  if (current.protocol !== 'http:' && current.protocol !== 'https:') {
    return fail(true, `refusing to call non-http(s) URL: ${input.url}`);
  }

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    try {
      const refusal = await checkHost(current.hostname, options.allowPrivate);
      if (refusal) return fail(true, refusal);
    } catch (err) {
      return fail(false, err instanceof Error ? err.message : String(err));
    }

    let res: Response;
    try {
      res = await fetch(current.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...input.headers },
        body: input.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(false, `POST ${current.hostname} failed: ${message}`);
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      await res.arrayBuffer().catch(() => undefined);
      if (hop === maxRedirects) {
        return fail(true, `too many redirects calling ${input.url}`);
      }
      const location = res.headers.get('location');
      if (!location) {
        return fail(true, `redirect without Location calling ${current.toString()}`);
      }
      let next: URL;
      try {
        next = new URL(location, current.toString());
      } catch {
        return fail(true, `invalid redirect Location calling ${current.toString()}`);
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        return fail(true, `redirect to non-http(s) URL calling ${current.toString()}`);
      }
      current = next;
      continue;
    }

    const { text, truncated } = await readCapped(res, maxBodyBytes);
    return {
      ok: true,
      status: res.status,
      body: text,
      truncated,
      latencyMs: Date.now() - started,
      url: current.toString(),
    };
  }
  return fail(true, `too many redirects calling ${input.url}`);
}
