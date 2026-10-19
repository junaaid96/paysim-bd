// Clock abstraction. ALL simulator time logic reads through Clock so the
// Phase 2 fake clock (per-workspace offsets in clock_state) can take over
// without touching call sites.

export interface Clock {
  now(workspaceId: string): Date;
}

/** Production default: wall-clock time, workspace-independent. */
export class SystemClock implements Clock {
  now(_workspaceId: string): Date {
    return new Date();
  }
}

/** Format a Date the way SSLCommerz-style APIs print datetimes. */
export function formatDbDatetime(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}
