// In-memory token registry: one store per router (per process in the
// API host). Restarts invalidate tokens — acceptable for a simulator
// (merchants re-grant, exactly like expiry). Token lifetimes read the
// plugin clock so fake-clock jumps expire tokens deterministically.

import { randomBytes } from 'node:crypto';

/** id_token lifetime: 3600s per docs. */
export const ID_TOKEN_TTL_MS = 3_600_000;
/** refresh_token lifetime: 30 days per docs. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3_600_000;

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
  issue(appId: string, nowMs: number): IssuedTokens;
  /** Rotate a refresh token; null when unknown, expired or foreign. */
  refresh(appId: string, refreshToken: string, nowMs: number): IssuedTokens | null;
  /** Resolve an id_token to its app; null when unknown or expired. */
  resolve(idToken: string, nowMs: number): string | null;
  /** Owning app without an expiry check (lets callers pick the clock first). */
  peek(idToken: string): string | null;
}

function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(16).toString('hex')}`;
}

export function createTokenStore(): TokenStore {
  const byIdToken = new Map<string, Entry>();
  const byRefreshToken = new Map<string, Entry>();

  function store(entry: Entry, nowMs: number): IssuedTokens {
    byIdToken.set(entry.idToken, entry);
    byRefreshToken.set(entry.refreshToken, entry);
    return {
      idToken: entry.idToken,
      refreshToken: entry.refreshToken,
      expiresIn: Math.max(0, Math.round((entry.expiresAtMs - nowMs) / 1000)),
    };
  }

  function remove(entry: Entry): void {
    byIdToken.delete(entry.idToken);
    byRefreshToken.delete(entry.refreshToken);
  }

  return {
    issue(appId: string, nowMs: number): IssuedTokens {
      return store(
        {
          appId,
          idToken: randomToken('sim_id_'),
          refreshToken: randomToken('sim_rt_'),
          expiresAtMs: nowMs + ID_TOKEN_TTL_MS,
          refreshExpiresAtMs: nowMs + REFRESH_TOKEN_TTL_MS,
        },
        nowMs,
      );
    },

    refresh(appId: string, refreshToken: string, nowMs: number): IssuedTokens | null {
      const entry = byRefreshToken.get(refreshToken);
      if (!entry || entry.appId !== appId || entry.refreshExpiresAtMs <= nowMs) {
        return null;
      }
      // Rotation invalidates the whole previous pair.
      remove(entry);
      return store(
        {
          appId,
          idToken: randomToken('sim_id_'),
          refreshToken: randomToken('sim_rt_'),
          expiresAtMs: nowMs + ID_TOKEN_TTL_MS,
          refreshExpiresAtMs: nowMs + REFRESH_TOKEN_TTL_MS,
        },
        nowMs,
      );
    },

    resolve(idToken: string, nowMs: number): string | null {
      const entry = byIdToken.get(idToken);
      if (!entry || entry.expiresAtMs <= nowMs) {
        return null;
      }
      return entry.appId;
    },

    peek(idToken: string): string | null {
      return byIdToken.get(idToken)?.appId ?? null;
    },
  };
}
