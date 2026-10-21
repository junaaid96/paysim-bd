import { createRealtimeClient, type RealtimeClient } from '@neon/realtime/client';

// One client per app: every subscription shares its connection. Null when the
// Realtime URL is not configured (local dev without Neon Realtime) — the feed
// falls back to REST data in that case.
let cached: RealtimeClient | null | undefined;

export function realtimeClient(): RealtimeClient | null {
  if (cached !== undefined) return cached;
  const url = import.meta.env['VITE_NEON_REALTIME_URL'] as string | undefined;
  cached =
    url && url !== ''
      ? createRealtimeClient({ url, logLevel: import.meta.env.DEV ? 'debug' : 'warn' })
      : null;
  return cached;
}
