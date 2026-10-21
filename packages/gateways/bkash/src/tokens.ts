// bKash token registry. Tokens live in a shared key/value store (Postgres
// on hosted deployments) so a token granted by one serverless instance is
// honoured by every other instance. Without a shared store (unit tests,
// bare routers) an in-memory map is used. Token lifetimes read the plugin
// clock so fake-clock jumps expire tokens deterministically.

import { randomBytes } from 'node:crypto';

import type { KeyValueStore } from '@paysim/core';

/** id_token lifetime: 3600s per docs. */
export const ID_TOKEN_TTL_MS = 3_600_000;
/** refresh_token lifetime: 30 days per docs. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3_600_000;

const NAMESPACE = 'bkash-token';

export interface IssuedTokens {
  idToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface Entry {
  appId: string;
  idToken: string;
  refreshToken: string;
  expiresAtMs: number;
  refreshExpiresAtMs: number;
}

export interface TokenStore {
  issue(appId: string, nowMs: number): Promise<IssuedTokens>;
  /** Rotate a refresh token; null when unknown, expired or foreign. */
  refresh(appId: string, refreshToken: string, nowMs: number): Promise<IssuedTokens | null>;
  /** Resolve an id_token to its app; null when unknown or expired. */
  resolve(idToken: string, nowMs: number): Promise<string | null>;
  /** Owning app without an expiry check (lets callers pick the clock first). */
  peek(idToken: string): Promise<string | null>;
}

/** Process-local KeyValueStore used when no shared store is wired. */
export function createMemoryKv(): KeyValueStore {
  const map = new Map<string, { value: Record<string, unknown>; expiresAt: number }>();
  return {
    async get(namespace, key) {
      const hit = map.get(`${namespace}\u0000${key}`);
      if (!hit) return null;
      if (hit.expiresAt <= Date.now()) {
        map.delete(`${namespace}\u0000${key}`);
        return null;
      }
      return hit.value;
    },
    async set(namespace, key, value, expiresAt) {
      map.set(`${namespace}\u0000${key}`, { value, expiresAt: expiresAt.getTime() });
    },
    async delete(namespace, key) {
      map.delete(`${namespace}\u0000${key}`);
    },
  };
}

function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(16).toString('hex')}`;
}

function parseEntry(value: Record<string, unknown> | null): Entry | null {
  if (!value) return null;
  const { appId, idToken, refreshToken, expiresAtMs, refreshExpiresAtMs } = value;
  if (
    typeof appId !== 'string' ||
    typeof idToken !== 'string' ||
    typeof refreshToken !== 'string' ||
    typeof expiresAtMs !== 'number' ||
    typeof refreshExpiresAtMs !== 'number'
  ) {
    return null;
  }
  return { appId, idToken, refreshToken, expiresAtMs, refreshExpiresAtMs };
}

/**
 * Storage TTL in wall-clock time. Validity is judged against the plugin
 * (possibly fake) clock, so rows are kept for the refresh lifetime plus a
 * margin; fake-clock jumps forward still expire tokens via the check.
 */
function storageExpiry(): Date {
  return new Date(Date.now() + REFRESH_TOKEN_TTL_MS + 24 * 3_600_000);
}

export function createTokenStore(kv: KeyValueStore = createMemoryKv()): TokenStore {
  async function store(entry: Entry, nowMs: number): Promise<IssuedTokens> {
    const value = { ...entry } as Record<string, unknown>;
    const expiresAt = storageExpiry();
    await kv.set(NAMESPACE, `id:${entry.idToken}`, value, expiresAt);
    await kv.set(NAMESPACE, `rt:${entry.refreshToken}`, value, expiresAt);
    return {
      idToken: entry.idToken,
      refreshToken: entry.refreshToken,
      expiresIn: Math.max(0, Math.round((entry.expiresAtMs - nowMs) / 1000)),
    };
  }

  function fresh(appId: string, nowMs: number): Entry {
    return {
      appId,
      idToken: randomToken('sim_id_'),
      refreshToken: randomToken('sim_rt_'),
      expiresAtMs: nowMs + ID_TOKEN_TTL_MS,
      refreshExpiresAtMs: nowMs + REFRESH_TOKEN_TTL_MS,
    };
  }

  return {
    issue(appId, nowMs) {
      return store(fresh(appId, nowMs), nowMs);
    },

    async refresh(appId, refreshToken, nowMs) {
      const entry = parseEntry(await kv.get(NAMESPACE, `rt:${refreshToken}`));
      if (!entry || entry.appId !== appId || entry.refreshExpiresAtMs <= nowMs) {
        return null;
      }
      // Rotation invalidates the whole previous pair.
      await kv.delete(NAMESPACE, `rt:${entry.refreshToken}`);
      await kv.delete(NAMESPACE, `id:${entry.idToken}`);
      return store(fresh(appId, nowMs), nowMs);
    },

    async resolve(idToken, nowMs) {
      const entry = parseEntry(await kv.get(NAMESPACE, `id:${idToken}`));
      if (!entry || entry.expiresAtMs <= nowMs) return null;
      return entry.appId;
    },

    async peek(idToken) {
      return parseEntry(await kv.get(NAMESPACE, `id:${idToken}`))?.appId ?? null;
    },
  };
}
